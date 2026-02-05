import { Router } from 'express';
import { observabilityController } from '../controllers/observability.controller';

const router = Router();

// All routes require authentication (handled by app.ts)

// Overview metrics
router.get('/metrics', (req, res) => observabilityController.getMetrics(req, res));

// Trend data for charts
router.get('/trends', (req, res) => observabilityController.getTrends(req, res));

// Alerts
router.get('/alerts', (req, res) => observabilityController.getAlerts(req, res));

// Performance by agent
router.get('/agents/performance', (req, res) => observabilityController.getAgentPerformance(req, res));

// Issue breakdown
router.get('/issues/breakdown', (req, res) => observabilityController.getIssueBreakdown(req, res));

export default router;
