import { Router } from 'express';
import { bookingController } from '../controllers/booking.controller';
import { generalRateLimiter, sensitiveOperationRateLimiter } from '../middleware/rateLimit.middleware';

const router = Router();

// GET /api/booking/availability?date=YYYY-MM-DD
router.get('/availability', generalRateLimiter, bookingController.getAvailableSlots.bind(bookingController));

// GET /api/booking/weekly-availability
router.get('/weekly-availability', generalRateLimiter, bookingController.getWeeklyAvailability.bind(bookingController));

// POST /api/booking (stricter rate limit to prevent spam bookings)
router.post('/', sensitiveOperationRateLimiter, bookingController.createBooking.bind(bookingController));

// GET /api/booking/:id
router.get('/:id', generalRateLimiter, bookingController.getBooking.bind(bookingController));

// POST /api/booking/:id/cancel
router.post('/:id/cancel', sensitiveOperationRateLimiter, bookingController.cancelBooking.bind(bookingController));

export default router;
