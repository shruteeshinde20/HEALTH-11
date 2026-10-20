"""Current weather at a position, from Open-Meteo (https://open-meteo.com).

Free, no key, for non-commercial use (commercial use needs Open-Meteo's paid
plan). Data under CC BY 4.0: every answer carries the credit. Answers are
kept for a few minutes per position, so repeated views do not call Open-Meteo
again. This is information only: the simulation does not use the weather.
"""

import threading
import time
from dataclasses import dataclass

import httpx

ATTRIBUTION = "Weather data by Open-Meteo.com (CC BY 4.0)"
ATTRIBUTION_URL = "https://open-meteo.com/"
USER_AGENT = "HEALTH-11 hospital evacuation planner (open source)"
VARIABLES = ("temperature_2m", "relative_humidity_2m", "wind_speed_10m", "wind_direction_10m", "wind_gusts_10m")
COMPASS = ("N", "NE", "E", "SE", "S", "SW", "W", "NW")


class WeatherError(Exception):
    """Open-Meteo could not answer (message is safe to show)."""


@dataclass(frozen=True)
class Weather:
    valid_at: str                  # local time at the hospital, as Open-Meteo gives it
    utc_offset_seconds: int
    interval_seconds: int | None   # current values are averages over this period
    temperature_c: float | None
    humidity_percent: float | None
    wind_speed_kmh: float | None
    wind_gusts_kmh: float | None
    wind_direction_deg: float | None   # where the wind comes FROM (meteorological)

    @property
    def wind_from(self) -> str | None:
        return compass(self.wind_direction_deg)

    @property
    def smoke_drifts_toward(self) -> str | None:
        if self.wind_direction_deg is None:
            return None
        return compass((self.wind_direction_deg + 180) % 360)


def compass(degrees: float | None) -> str | None:
    if degrees is None:
        return None
    return COMPASS[int(((degrees % 360) + 22.5) // 45) % 8]


def _number(value) -> float | None:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def parse(payload: dict) -> Weather:
    current = payload.get("current") if isinstance(payload, dict) else None
    if not isinstance(current, dict) or not isinstance(current.get("time"), str):
        raise WeatherError("Open-Meteo sent an answer without current weather. Try again later.")
    offset = payload.get("utc_offset_seconds")
    interval = current.get("interval")
    return Weather(
        valid_at=current["time"][:32],
        utc_offset_seconds=int(offset) if isinstance(offset, int) else 0,
        interval_seconds=int(interval) if isinstance(interval, int) else None,
        temperature_c=_number(current.get("temperature_2m")),
        humidity_percent=_number(current.get("relative_humidity_2m")),
        wind_speed_kmh=_number(current.get("wind_speed_10m")),
        wind_gusts_kmh=_number(current.get("wind_gusts_10m")),
        wind_direction_deg=_number(current.get("wind_direction_10m")),
    )


_cache: dict[tuple[float, float], tuple[float, Weather]] = {}
_cache_lock = threading.Lock()


def clear_cache() -> None:
    with _cache_lock:
        _cache.clear()


def cached(latitude: float, longitude: float, max_age_seconds: float) -> Weather | None:
    key = (round(latitude, 3), round(longitude, 3))
    with _cache_lock:
        hit = _cache.get(key)
    if hit and time.monotonic() - hit[0] < max_age_seconds:
        return hit[1]
    return None


def current_weather(url: str, latitude: float, longitude: float, *, timeout: float,
                    transport: httpx.BaseTransport | None = None) -> Weather:
    params = {"latitude": f"{latitude:.4f}", "longitude": f"{longitude:.4f}", "current": ",".join(VARIABLES),
              "wind_speed_unit": "kmh", "temperature_unit": "celsius", "timezone": "auto"}
    try:
        with httpx.Client(timeout=timeout, transport=transport,
                          headers={"User-Agent": USER_AGENT, "Accept": "application/json"}) as client:
            response = client.get(url, params=params)
    except httpx.HTTPError:
        raise WeatherError("Open-Meteo could not be reached. Check the internet connection and try again.") from None
    if response.status_code == 429:
        raise WeatherError("Open-Meteo's free daily limit is used up for now. Try again later.")
    if response.status_code != 200:
        raise WeatherError(f"Open-Meteo answered with an error ({response.status_code}). Try again later.")
    try:
        weather = parse(response.json())
    except ValueError:
        raise WeatherError("Open-Meteo sent an answer that could not be read. Try again later.") from None
    with _cache_lock:
        _cache[(round(latitude, 3), round(longitude, 3))] = (time.monotonic(), weather)
    return weather
