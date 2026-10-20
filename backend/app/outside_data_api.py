"""Outside data for a hospital (PROJECT.md "Optional context imports").

GET /hospitals/{id}/openstreetmap?radius_m=1500
    Hospitals near this hospital's map position, from OpenStreetMap. The user
    then chooses one in the website and saves its address and position with
    the normal hospital update; nothing is stored here. Every answer names its
    source, licence and time.

Administrators and Emergency Commanders only (the result is used to change a
hospital). Limited per organization and in total per day, to respect the
OpenStreetMap fair-use rules. OSM_ENABLED=false switches it off.
"""

from datetime import datetime, timezone
from typing import Annotated

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app import rate_limit
from app.api_common import get_active
from app.config import get_settings
from app.db_session import get_db
from app.models.facility import Hospital
from app.permissions import Editor
from app.services import openstreetmap

router = APIRouter(tags=["Outside data"])

Db = Annotated[Session, Depends(get_db)]
DAY_SECONDS = 86_400

# Tests replace this with httpx.MockTransport; None means the real internet.
OSM_TRANSPORT: httpx.BaseTransport | None = None


@router.get("/hospitals/{hospital_id}/openstreetmap")
def openstreetmap_nearby(hospital_id: int, db: Db, user: Editor,
                         radius_m: Annotated[int, Query(ge=100, le=5000)] = 1500):
    settings = get_settings()
    if not settings.osm_enabled:
        raise HTTPException(status_code=503,
                            detail="OpenStreetMap lookups are switched off on this server (OSM_ENABLED).")
    hospital = get_active(db, Hospital, hospital_id, user.organization_id, "Hospital")
    if hospital.latitude is None or hospital.longitude is None:
        raise HTTPException(status_code=422,
                            detail="Add the hospital's map position first (Edit hospital), then search nearby.")

    # Fair use: both limits are checked before either is counted.
    org_key = rate_limit.bucket_key("osm:organization", str(user.organization_id))
    all_key = rate_limit.bucket_key("osm:server", "all")
    rate_limit.ensure_not_limited(db, org_key, settings.osm_searches_per_organization_per_day, DAY_SECONDS)
    rate_limit.ensure_not_limited(db, all_key, settings.osm_searches_per_day, DAY_SECONDS)
    rate_limit.record_event(db, org_key)
    rate_limit.record_event(db, all_key)
    db.commit()

    try:
        places = openstreetmap.nearby_hospitals(
            settings.overpass_urls, hospital.latitude, hospital.longitude, radius_m,
            timeout=settings.osm_timeout_seconds, transport=OSM_TRANSPORT,
        )
    except openstreetmap.OsmError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from None

    return {
        "source": "OpenStreetMap (Overpass API)",
        "attribution": openstreetmap.ATTRIBUTION,
        "attribution_url": openstreetmap.ATTRIBUTION_URL,
        "searched_at": datetime.now(timezone.utc).isoformat(),
        "radius_m": radius_m,
        "places": [
            {"osm_type": p.osm_type, "osm_id": p.osm_id, "url": p.url, "name": p.name, "address": p.address,
             "latitude": p.latitude, "longitude": p.longitude, "distance_m": p.distance_m}
            for p in places
        ],
    }
