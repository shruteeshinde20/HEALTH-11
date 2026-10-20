"""Outside data for a hospital (PROJECT.md "Optional context imports").

GET /hospitals/{id}/weather
    Current weather at the hospital's map position, from Open-Meteo: wind
    speed, gusts and direction (and where smoke would drift), temperature and
    humidity, with source, licence and time. Information only: simulations do
    not use it. Any signed-in user of the organization may see it.

WEATHER_ENABLED=false switches it off. Answers are kept for a few minutes per
position, and calls to Open-Meteo are limited per day in total.
"""

from datetime import datetime, timezone
from typing import Annotated

import httpx
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app import rate_limit
from app.api_common import get_active
from app.config import get_settings
from app.db_session import get_db
from app.models.facility import Hospital
from app.permissions import Reader
from app.services import weather as weather_service

router = APIRouter(tags=["Outside data"])

Db = Annotated[Session, Depends(get_db)]
DAY_SECONDS = 86_400

# Tests replace this with httpx.MockTransport; None means the real internet.
WEATHER_TRANSPORT: httpx.BaseTransport | None = None


@router.get("/hospitals/{hospital_id}/weather")
def hospital_weather(hospital_id: int, db: Db, user: Reader):
    settings = get_settings()
    if not settings.weather_enabled:
        raise HTTPException(status_code=503, detail="Weather is switched off on this server (WEATHER_ENABLED).")
    hospital = get_active(db, Hospital, hospital_id, user.organization_id, "Hospital")
    if hospital.latitude is None or hospital.longitude is None:
        raise HTTPException(status_code=422,
                            detail="This hospital has no map position yet (Facility Manager, Edit hospital).")

    current = weather_service.cached(hospital.latitude, hospital.longitude, settings.weather_cache_minutes * 60)
    if current is None:
        rate_limit.hit(db, rate_limit.bucket_key("weather:server", "all"),
                       settings.weather_requests_per_day, DAY_SECONDS)
        try:
            current = weather_service.current_weather(
                settings.open_meteo_url, hospital.latitude, hospital.longitude,
                timeout=settings.weather_timeout_seconds, transport=WEATHER_TRANSPORT)
        except weather_service.WeatherError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from None

    return {
        "source": "Open-Meteo",
        "attribution": weather_service.ATTRIBUTION,
        "attribution_url": weather_service.ATTRIBUTION_URL,
        "note": "Information only: the simulation does not use the weather.",
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "valid_at": current.valid_at,
        "utc_offset_seconds": current.utc_offset_seconds,
        "interval_seconds": current.interval_seconds,
        "temperature_c": current.temperature_c,
        "humidity_percent": current.humidity_percent,
        "wind_speed_kmh": current.wind_speed_kmh,
        "wind_gusts_kmh": current.wind_gusts_kmh,
        "wind_direction_deg": current.wind_direction_deg,
        "wind_from": current.wind_from,
        "smoke_drifts_toward": current.smoke_drifts_toward,
    }
