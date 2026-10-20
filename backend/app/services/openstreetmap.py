"""Hospitals near a position, from OpenStreetMap (Overpass API).

OpenStreetMap data is © OpenStreetMap contributors, available under the Open
Database License (ODbL); every answer carries that credit. The public Overpass
server is free and needs no key; its fair-use limits are respected by the
caller (rate limits in the API). Nothing here is stored: the user picks a
result and saves it to the hospital themselves.
"""

import math
from dataclasses import dataclass

import httpx

ATTRIBUTION = "© OpenStreetMap contributors (ODbL)"
ATTRIBUTION_URL = "https://www.openstreetmap.org/copyright"
USER_AGENT = "HEALTH-11 hospital evacuation planner (open source)"
MAX_RESULTS = 25


class OsmError(Exception):
    """OpenStreetMap could not answer (message is safe to show)."""


@dataclass(frozen=True)
class OsmPlace:
    osm_type: str          # node, way or relation
    osm_id: int
    name: str | None
    address: str | None
    latitude: float
    longitude: float
    distance_m: float

    @property
    def url(self) -> str:
        return f"https://www.openstreetmap.org/{self.osm_type}/{self.osm_id}"


def overpass_query(latitude: float, longitude: float, radius_m: int) -> str:
    # Hospitals as points, buildings or areas within the radius; ways and
    # relations get their centre. Only numbers are put into the query.
    return (
        "[out:json][timeout:25];"
        f'nwr["amenity"="hospital"](around:{int(radius_m)},{latitude:.6f},{longitude:.6f});'
        f"out center {MAX_RESULTS};"
    )


def distance_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in metres (haversine, mean Earth radius)."""
    r = 6_371_008.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def address_from_tags(tags: dict) -> str | None:
    if tags.get("addr:full"):
        return str(tags["addr:full"])[:500]
    street = " ".join(str(tags[k]) for k in ("addr:housenumber", "addr:street") if tags.get(k))
    parts = [street] + [str(tags[k]) for k in ("addr:suburb", "addr:city", "addr:postcode", "addr:state")
                        if tags.get(k)]
    text = ", ".join(part for part in parts if part)
    return text[:500] or None


def parse(payload: dict, latitude: float, longitude: float) -> list[OsmPlace]:
    places = []
    for element in payload.get("elements", []) if isinstance(payload, dict) else []:
        if not isinstance(element, dict) or element.get("type") not in {"node", "way", "relation"}:
            continue
        point = element if "lat" in element else element.get("center") or {}
        lat, lon = point.get("lat"), point.get("lon")
        if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
            continue
        tags = element.get("tags") if isinstance(element.get("tags"), dict) else {}
        name = tags.get("name") or tags.get("name:en")
        places.append(OsmPlace(
            osm_type=element["type"], osm_id=int(element["id"]),
            name=str(name)[:200] if name else None, address=address_from_tags(tags),
            latitude=float(lat), longitude=float(lon),
            distance_m=round(distance_m(latitude, longitude, float(lat), float(lon)), 1),
        ))
    places.sort(key=lambda place: place.distance_m)
    return places[:MAX_RESULTS]


def nearby_hospitals(url: str, latitude: float, longitude: float, radius_m: int, *,
                     timeout: float, transport: httpx.BaseTransport | None = None) -> list[OsmPlace]:
    try:
        with httpx.Client(timeout=timeout, transport=transport,
                          headers={"User-Agent": USER_AGENT, "Accept": "application/json"}) as client:
            response = client.post(url, data={"data": overpass_query(latitude, longitude, radius_m)})
    except httpx.HTTPError:
        raise OsmError("OpenStreetMap could not be reached. Check the internet connection and try again.") from None
    if response.status_code in (429, 504):
        raise OsmError("OpenStreetMap is busy right now. Wait a minute and try again.")
    if response.status_code != 200:
        raise OsmError(f"OpenStreetMap answered with an error ({response.status_code}). Try again later.")
    try:
        payload = response.json()
    except ValueError:
        raise OsmError("OpenStreetMap sent an answer that could not be read. Try again later.") from None
    return parse(payload, latitude, longitude)
