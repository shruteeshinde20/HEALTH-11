from fastapi import APIRouter

from app.analysis_api import router as analysis_router
from app.audit_api import router as audit_router
from app.auth import router as auth_router
from app.facility_api import router as facility_router
from app.floor_io import router as floor_io_router
from app.graph_api import router as graph_router
from app.parameter_api import router as parameter_router
from app.people_api import router as people_router
from app.scenario_api import router as scenario_router
from app.users_api import router as users_router

router = APIRouter()
router.include_router(auth_router)
router.include_router(facility_router)
router.include_router(graph_router)
router.include_router(floor_io_router)
router.include_router(people_router)
router.include_router(scenario_router)
router.include_router(analysis_router)
router.include_router(parameter_router)
router.include_router(users_router)
router.include_router(audit_router)
