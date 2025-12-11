import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import swaggerUi from 'swagger-ui-express';
import { config } from './config';
import { swaggerSpec } from './config/swagger';
import routes from './routes';
import { clerkAuth, requireAuthentication } from './middleware/auth.middleware';
import { errorHandler, notFoundHandler } from './middleware/error.middleware';

const app = express();

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false, // Disable for Swagger UI
}));

// CORS configuration
app.use(cors({
  origin: config.cors.frontendUrl,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Request logging
app.use(morgan('dev'));

// Body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Swagger documentation (public)
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
  explorer: true,
  customCss: '.swagger-ui .topbar { display: none }',
  customSiteTitle: 'Voice Agent QA API Docs',
}));

// Swagger JSON spec
app.get('/api/docs.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.send(swaggerSpec);
});

// Clerk authentication middleware
app.use(clerkAuth);

// Public routes (health check)
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Protected API routes
app.use('/api', requireAuthentication, routes);

// 404 handler
app.use(notFoundHandler);

// Error handler
app.use(errorHandler);

export default app;
