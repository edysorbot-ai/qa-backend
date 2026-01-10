import { Router, Request, Response } from "express";
import { ScheduledTestModel } from "../models/scheduledTest.model";
import { userService } from "../services/user.service";
import { 
  requireSubscriptionAndCredits,
  FeatureKeys 
} from '../middleware/credits.middleware';

const router = Router();

// Helper to get user ID from Clerk auth
const getUserId = async (req: Request): Promise<string> => {
  const clerkUser = (req as any).auth;
  if (!clerkUser?.userId) {
    throw new Error("Unauthorized");
  }
  const user = await userService.findOrCreateByClerkId(clerkUser.userId);
  return user.id;
};

// Get all scheduled tests for the current user
router.get("/", async (req: Request, res: Response) => {
  try {
    const userId = await getUserId(req);
    const scheduledTests = await ScheduledTestModel.findByUserId(userId);
    res.json({ scheduledTests });
  } catch (error: any) {
    if (error.message === "Unauthorized") {
      return res.status(401).json({ error: "Unauthorized" });
    }
    console.error("Error fetching scheduled tests:", error);
    res.status(500).json({ error: "Failed to fetch scheduled tests" });
  }
});

// Get a specific scheduled test
router.get("/:id", async (req: Request, res: Response) => {
  try {
    const userId = await getUserId(req);
    const { id } = req.params;

    const scheduledTest = await ScheduledTestModel.findById(id, userId);
    if (!scheduledTest) {
      return res.status(404).json({ error: "Scheduled test not found" });
    }

    res.json({ scheduledTest });
  } catch (error: any) {
    if (error.message === "Unauthorized") {
      return res.status(401).json({ error: "Unauthorized" });
    }
    console.error("Error fetching scheduled test:", error);
    res.status(500).json({ error: "Failed to fetch scheduled test" });
  }
});

// Create a new scheduled test (requires subscription and credits)
router.post("/", 
  ...requireSubscriptionAndCredits(FeatureKeys.SCHEDULED_TEST_CREATE),
  async (req: Request, res: Response) => {
  try {
    const userId = await getUserId(req);
    const {
      name,
      agentId,
      agentName,
      provider,
      integrationId,
      externalAgentId,
      batches,
      scheduleType,
      scheduledTime,
      scheduledDate,
      scheduledDays,
      timezone,
      endsType,
      endsOnDate,
      endsAfterOccurrences,
      enableBatching,
      enableConcurrency,
      concurrencyCount,
    } = req.body;

    // Validate required fields
    if (!name || !agentId || !agentName || !provider || !batches || !scheduleType || !scheduledTime) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Validate schedule type specific fields
    if (scheduleType === "once" && !scheduledDate) {
      return res.status(400).json({ error: "Scheduled date is required for one-time schedules" });
    }

    if (scheduleType === "weekly" && (!scheduledDays || scheduledDays.length === 0)) {
      return res.status(400).json({ error: "At least one day must be selected for weekly schedules" });
    }

    // Validate end options for recurring schedules
    if ((scheduleType === "daily" || scheduleType === "weekly") && endsType) {
      if (endsType === "on" && !endsOnDate) {
        return res.status(400).json({ error: "End date is required when 'ends on' is selected" });
      }
      if (endsType === "after" && (!endsAfterOccurrences || endsAfterOccurrences < 1)) {
        return res.status(400).json({ error: "Number of occurrences must be at least 1" });
      }
    }

    const scheduledTest = await ScheduledTestModel.create({
      userId,
      name,
      agentId,
      agentName,
      provider,
      integrationId,
      externalAgentId,
      batches,
      scheduleType,
      scheduledTime,
      scheduledDate,
      scheduledDays,
      timezone: timezone || "UTC",
      endsType: endsType || "never",
      endsOnDate,
      endsAfterOccurrences,
      enableBatching: enableBatching ?? true,
      enableConcurrency: enableConcurrency ?? false,
      concurrencyCount: concurrencyCount || 1,
    });

    res.status(201).json({ scheduledTest });
  } catch (error: any) {
    if (error.message === "Unauthorized") {
      return res.status(401).json({ error: "Unauthorized" });
    }
    console.error("Error creating scheduled test:", error);
    res.status(500).json({ error: "Failed to create scheduled test" });
  }
});

// Update a scheduled test
router.put("/:id", async (req: Request, res: Response) => {
  try {
    const userId = await getUserId(req);
    const { id } = req.params;
    const updates = req.body;

    const scheduledTest = await ScheduledTestModel.update(id, userId, updates);
    if (!scheduledTest) {
      return res.status(404).json({ error: "Scheduled test not found" });
    }

    res.json({ scheduledTest });
  } catch (error: any) {
    if (error.message === "Unauthorized") {
      return res.status(401).json({ error: "Unauthorized" });
    }
    console.error("Error updating scheduled test:", error);
    res.status(500).json({ error: "Failed to update scheduled test" });
  }
});

// Toggle scheduled test status (pause/resume)
router.patch("/:id/toggle", async (req: Request, res: Response) => {
  try {
    const userId = await getUserId(req);
    const { id } = req.params;

    const scheduledTest = await ScheduledTestModel.findById(id, userId);
    if (!scheduledTest) {
      return res.status(404).json({ error: "Scheduled test not found" });
    }

    const newStatus = scheduledTest.status === "active" ? "paused" : "active";
    await ScheduledTestModel.updateStatus(id, newStatus);

    res.json({ status: newStatus });
  } catch (error: any) {
    if (error.message === "Unauthorized") {
      return res.status(401).json({ error: "Unauthorized" });
    }
    console.error("Error toggling scheduled test:", error);
    res.status(500).json({ error: "Failed to toggle scheduled test" });
  }
});

// Delete a scheduled test
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const userId = await getUserId(req);
    const { id } = req.params;

    const deleted = await ScheduledTestModel.delete(id, userId);
    if (!deleted) {
      return res.status(404).json({ error: "Scheduled test not found" });
    }

    res.json({ success: true });
  } catch (error: any) {
    if (error.message === "Unauthorized") {
      return res.status(401).json({ error: "Unauthorized" });
    }
    console.error("Error deleting scheduled test:", error);
    res.status(500).json({ error: "Failed to delete scheduled test" });
  }
});

export default router;
