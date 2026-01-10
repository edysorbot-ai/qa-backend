import express from "express";
import { AdminModel } from "../models/admin.model";
import { adminAuth, AdminRequest, generateAdminToken } from "../middleware/admin.middleware";

const router = express.Router();

// Public route - Admin Login
router.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: "Username and password are required" });
    }

    const admin = await AdminModel.authenticateAdmin(username, password);

    if (!admin) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const token = generateAdminToken(admin);

    res.json({
      token,
      admin: {
        id: admin.id,
        username: admin.username,
        role: admin.role,
      },
    });
  } catch (error) {
    console.error("Admin login error:", error);
    res.status(500).json({ error: "Login failed" });
  }
});

// Protected routes - require admin authentication
router.use(adminAuth);

// Dashboard Stats
router.get("/dashboard", async (req: AdminRequest, res) => {
  try {
    const stats = await AdminModel.getDashboardStats();
    res.json(stats);
  } catch (error) {
    console.error("Dashboard stats error:", error);
    res.status(500).json({ error: "Failed to fetch dashboard stats" });
  }
});

// ==================== Users ====================
router.get("/users", async (req: AdminRequest, res) => {
  try {
    const users = await AdminModel.getAllUsers();
    res.json(users);
  } catch (error) {
    console.error("Get users error:", error);
    res.status(500).json({ error: "Failed to fetch users" });
  }
});

router.get("/users/:id", async (req: AdminRequest, res) => {
  try {
    const user = await AdminModel.getUserById(req.params.id);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    res.json(user);
  } catch (error) {
    console.error("Get user error:", error);
    res.status(500).json({ error: "Failed to fetch user" });
  }
});

router.patch("/users/:id", async (req: AdminRequest, res) => {
  try {
    const user = await AdminModel.updateUser(req.params.id, req.body);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    res.json(user);
  } catch (error) {
    console.error("Update user error:", error);
    res.status(500).json({ error: "Failed to update user" });
  }
});

router.delete("/users/:id", async (req: AdminRequest, res) => {
  try {
    const deleted = await AdminModel.deleteUser(req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: "User not found" });
    }
    res.json({ message: "User deleted successfully" });
  } catch (error) {
    console.error("Delete user error:", error);
    res.status(500).json({ error: "Failed to delete user" });
  }
});

// Sync all users from Clerk (fixes users with incorrect email/name)
router.post("/users/sync-from-clerk", async (req: AdminRequest, res) => {
  try {
    const { userService } = await import("../services/user.service");
    const result = await userService.syncAllUsersFromClerk();
    res.json({ 
      message: "User sync completed",
      ...result 
    });
  } catch (error) {
    console.error("Sync users error:", error);
    res.status(500).json({ error: "Failed to sync users from Clerk" });
  }
});

// User Credits Management
router.post("/users/:id/credits", async (req: AdminRequest, res) => {
  try {
    const { credits, description } = req.body;
    if (!credits || credits <= 0) {
      return res.status(400).json({ error: "Credits must be a positive number" });
    }
    const userCredit = await AdminModel.addCreditsToUser(
      req.params.id,
      credits,
      description || "Credits added by admin"
    );
    res.json(userCredit);
  } catch (error) {
    console.error("Add credits error:", error);
    res.status(500).json({ error: "Failed to add credits" });
  }
});

router.post("/users/:id/package", async (req: AdminRequest, res) => {
  try {
    const { packageId } = req.body;
    if (!packageId) {
      return res.status(400).json({ error: "Package ID is required" });
    }
    const userCredit = await AdminModel.setUserPackage(req.params.id, packageId);
    if (!userCredit) {
      return res.status(404).json({ error: "User or package not found" });
    }
    res.json(userCredit);
  } catch (error) {
    console.error("Set package error:", error);
    res.status(500).json({ error: "Failed to set package" });
  }
});

// Get user features based on their package
router.get("/users/:id/features", async (req: AdminRequest, res) => {
  try {
    const features = await AdminModel.getUserFeatures(req.params.id);
    res.json(features);
  } catch (error) {
    console.error("Get user features error:", error);
    res.status(500).json({ error: "Failed to fetch user features" });
  }
});

// ==================== Integrations ====================
router.get("/integrations", async (req: AdminRequest, res) => {
  try {
    const integrations = await AdminModel.getAllIntegrations();
    res.json(integrations);
  } catch (error) {
    console.error("Get integrations error:", error);
    res.status(500).json({ error: "Failed to fetch integrations" });
  }
});

router.patch("/integrations/:id", async (req: AdminRequest, res) => {
  try {
    const integration = await AdminModel.updateIntegration(req.params.id, req.body);
    if (!integration) {
      return res.status(404).json({ error: "Integration not found" });
    }
    res.json(integration);
  } catch (error) {
    console.error("Update integration error:", error);
    res.status(500).json({ error: "Failed to update integration" });
  }
});

// ==================== Packages ====================
router.get("/packages", async (req: AdminRequest, res) => {
  try {
    const packages = await AdminModel.getAllPackages();
    res.json(packages);
  } catch (error) {
    console.error("Get packages error:", error);
    res.status(500).json({ error: "Failed to fetch packages" });
  }
});

router.post("/packages", async (req: AdminRequest, res) => {
  try {
    const pkg = await AdminModel.createPackage(req.body);
    res.status(201).json(pkg);
  } catch (error) {
    console.error("Create package error:", error);
    res.status(500).json({ error: "Failed to create package" });
  }
});

router.patch("/packages/:id", async (req: AdminRequest, res) => {
  try {
    const pkg = await AdminModel.updatePackage(req.params.id, req.body);
    if (!pkg) {
      return res.status(404).json({ error: "Package not found" });
    }
    res.json(pkg);
  } catch (error) {
    console.error("Update package error:", error);
    res.status(500).json({ error: "Failed to update package" });
  }
});

router.delete("/packages/:id", async (req: AdminRequest, res) => {
  try {
    const deleted = await AdminModel.deletePackage(req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: "Package not found" });
    }
    res.json({ message: "Package deleted successfully" });
  } catch (error) {
    console.error("Delete package error:", error);
    res.status(500).json({ error: "Failed to delete package" });
  }
});

// ==================== Feature Costs ====================
router.get("/feature-costs", async (req: AdminRequest, res) => {
  try {
    const costs = await AdminModel.getAllFeatureCosts();
    res.json(costs);
  } catch (error) {
    console.error("Get feature costs error:", error);
    res.status(500).json({ error: "Failed to fetch feature costs" });
  }
});

router.post("/feature-costs", async (req: AdminRequest, res) => {
  try {
    const cost = await AdminModel.createFeatureCost(req.body);
    res.status(201).json(cost);
  } catch (error) {
    console.error("Create feature cost error:", error);
    res.status(500).json({ error: "Failed to create feature cost" });
  }
});

router.patch("/feature-costs/:id", async (req: AdminRequest, res) => {
  try {
    const cost = await AdminModel.updateFeatureCost(req.params.id, req.body);
    if (!cost) {
      return res.status(404).json({ error: "Feature cost not found" });
    }
    res.json(cost);
  } catch (error) {
    console.error("Update feature cost error:", error);
    res.status(500).json({ error: "Failed to update feature cost" });
  }
});

// ==================== Credit Pricing ====================
router.get("/pricing", async (req: AdminRequest, res) => {
  try {
    const pricing = await AdminModel.getCreditPricing();
    res.json(pricing);
  } catch (error) {
    console.error("Get pricing error:", error);
    res.status(500).json({ error: "Failed to fetch pricing" });
  }
});

router.patch("/pricing", async (req: AdminRequest, res) => {
  try {
    const pricing = await AdminModel.updateCreditPricing(req.body);
    res.json(pricing);
  } catch (error) {
    console.error("Update pricing error:", error);
    res.status(500).json({ error: "Failed to update pricing" });
  }
});

// ==================== Coupons ====================
router.get("/coupons", async (req: AdminRequest, res) => {
  try {
    const coupons = await AdminModel.getAllCoupons();
    res.json(coupons);
  } catch (error) {
    console.error("Get coupons error:", error);
    res.status(500).json({ error: "Failed to fetch coupons" });
  }
});

router.post("/coupons", async (req: AdminRequest, res) => {
  try {
    const coupon = await AdminModel.createCoupon(req.body);
    res.status(201).json(coupon);
  } catch (error: any) {
    console.error("Create coupon error:", error);
    if (error.code === "23505") {
      return res.status(400).json({ error: "Coupon code already exists" });
    }
    res.status(500).json({ error: "Failed to create coupon" });
  }
});

router.patch("/coupons/:id", async (req: AdminRequest, res) => {
  try {
    const coupon = await AdminModel.updateCoupon(req.params.id, req.body);
    if (!coupon) {
      return res.status(404).json({ error: "Coupon not found" });
    }
    res.json(coupon);
  } catch (error: any) {
    console.error("Update coupon error:", error);
    if (error.code === "23505") {
      return res.status(400).json({ error: "Coupon code already exists" });
    }
    res.status(500).json({ error: "Failed to update coupon" });
  }
});

router.delete("/coupons/:id", async (req: AdminRequest, res) => {
  try {
    const deleted = await AdminModel.deleteCoupon(req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: "Coupon not found" });
    }
    res.json({ message: "Coupon deleted successfully" });
  } catch (error) {
    console.error("Delete coupon error:", error);
    res.status(500).json({ error: "Failed to delete coupon" });
  }
});

// ==================== Referral Links ====================
router.get("/referrals", async (req: AdminRequest, res) => {
  try {
    const referrals = await AdminModel.getAllReferralLinks();
    res.json(referrals);
  } catch (error) {
    console.error("Get referrals error:", error);
    res.status(500).json({ error: "Failed to fetch referrals" });
  }
});

router.post("/referrals", async (req: AdminRequest, res) => {
  try {
    const referral = await AdminModel.createReferralLink(req.body);
    res.status(201).json(referral);
  } catch (error: any) {
    console.error("Create referral error:", error);
    if (error.code === "23505") {
      return res.status(400).json({ error: "Referral code already exists" });
    }
    res.status(500).json({ error: "Failed to create referral" });
  }
});

router.patch("/referrals/:id", async (req: AdminRequest, res) => {
  try {
    const referral = await AdminModel.updateReferralLink(req.params.id, req.body);
    if (!referral) {
      return res.status(404).json({ error: "Referral not found" });
    }
    res.json(referral);
  } catch (error: any) {
    console.error("Update referral error:", error);
    if (error.code === "23505") {
      return res.status(400).json({ error: "Referral code already exists" });
    }
    res.status(500).json({ error: "Failed to update referral" });
  }
});

router.delete("/referrals/:id", async (req: AdminRequest, res) => {
  try {
    const deleted = await AdminModel.deleteReferralLink(req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: "Referral not found" });
    }
    res.json({ message: "Referral deleted successfully" });
  } catch (error) {
    console.error("Delete referral error:", error);
    res.status(500).json({ error: "Failed to delete referral" });
  }
});

// ==================== Credit Transactions ====================
router.get("/transactions", async (req: AdminRequest, res) => {
  try {
    const { userId, limit } = req.query;
    const transactions = await AdminModel.getCreditTransactions(
      userId as string | undefined,
      limit ? parseInt(limit as string) : undefined
    );
    res.json(transactions);
  } catch (error) {
    console.error("Get transactions error:", error);
    res.status(500).json({ error: "Failed to fetch transactions" });
  }
});

export default router;
