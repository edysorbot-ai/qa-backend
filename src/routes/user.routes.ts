import { Router } from 'express';
import { userController } from '../controllers/user.controller';

const router = Router();

// GET /api/users/me - Get current user
router.get('/me', userController.getMe.bind(userController));

// PUT /api/users/me - Update current user
router.put('/me', userController.updateMe.bind(userController));

// GET /api/users/dashboard - Get dashboard stats
router.get('/dashboard', userController.getDashboardStats.bind(userController));

export default router;
