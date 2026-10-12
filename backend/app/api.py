from fastapi import APIRouter

from app.auth import router as auth_router
from app.facility_api import router as facility_router
from app.floor_io import router as floor_io_router
from app.graph_api import router as graph_router

router = APIRouter()
router.include_router(auth_router)
router.include_router(facility_router)
router.include_router(graph_router)
router.include_router(floor_io_router)
