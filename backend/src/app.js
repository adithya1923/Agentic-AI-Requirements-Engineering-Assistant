import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import healthRoutes from './routes/health.js';
import projectRoutes from './routes/projects.js';
import userRoutes from './routes/users.js';
import inputRoutes from './routes/inputs.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { createKnowledgeRouter } from './routes/knowledge.js';
import { createRequirementsRouter } from './routes/requirements.js';
import { createRequirementAnalysisRouter } from './routes/requirement-analysis.js';

export function createApp(options = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors({ origin: config.frontendOrigin }));
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/health', healthRoutes);
  app.use('/api/projects', projectRoutes);
  app.use('/api/users', userRoutes);
  app.use('/api', inputRoutes);
  app.use('/api/knowledge', createKnowledgeRouter(options));
  app.use('/api', createRequirementsRouter(options));
  app.use('/api', createRequirementAnalysisRouter({
    database: options.analysisDatabase || options.database || undefined,
    generateOutput: options.generateOutput,
    modelName: options.modelName,
  }));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

export const app = createApp();
