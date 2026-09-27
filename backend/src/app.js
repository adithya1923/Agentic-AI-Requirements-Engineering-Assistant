import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import healthRoutes from './routes/health.js';
import projectRoutes from './routes/projects.js';
import userRoutes from './routes/users.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';

export const app = express();
app.disable('x-powered-by');
app.use(cors({ origin: config.frontendOrigin }));
app.use(express.json({ limit: '1mb' }));
app.use('/api/health', healthRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/users', userRoutes);
app.use(notFoundHandler);
app.use(errorHandler);
