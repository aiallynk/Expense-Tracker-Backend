import { Router } from 'express';

import { TeamsController } from '../controllers/teams.controller';
import { ManagerController } from '../controllers/manager.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { requireRole } from '../middleware/role.middleware';
import { UserRole } from '../utils/enums';

const router = Router();

// All routes require authentication and manager role
router.use(authMiddleware);
router.use(requireRole(UserRole.MANAGER));

// Team management routes
router.post('/', TeamsController.createTeam);
router.get('/', TeamsController.getTeams);
router.get('/stats', TeamsController.getTeamStats);
router.get('/search-employees', TeamsController.searchEmployees);
// Spending details route (must come before /:id to avoid route conflicts)
router.get('/:teamId/spending', ManagerController.getTeamSpendingDetails);
router.get('/:id', TeamsController.getTeam);
router.post('/:id/members', TeamsController.addMembers);
router.delete('/:id/members/:userId', TeamsController.removeMember);

export default router;

