import { randomUUID } from 'node:crypto';
import fastifyMultipart from '@fastify/multipart';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { AppConfig } from '../config/env.js';
import { createLocalAdapters, createServices, type Adapters } from '../container.js';
import { errorHandler, notFoundHandler } from './errors.js';
import { documentRoutes } from './routes/documents.js';

export interface BuildAppOptions {
  readonly config: AppConfig;
  /** Override individual adapters (used by tests; later by AWS wiring). */
  readonly adapters?: Partial<Adapters>;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { config } = options;

  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-api-key"]'],
        censor: '[REDACTED]',
      },
    },
    // Accept a caller-supplied correlation ID only if it is well-formed, to avoid log injection.
    requestIdHeader: false,
    genReqId: (req) => {
      const header = req.headers['x-request-id'];
      return typeof header === 'string' && REQUEST_ID_PATTERN.test(header) ? header : randomUUID();
    },
    requestTimeout: config.requestTimeoutMs,
    bodyLimit: 1024 * 1024,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);

  app.addHook('onRequest', async (request, reply) => {
    void reply.header('x-request-id', request.id);
  });

  await app.register(fastifyMultipart, {
    limits: {
      fileSize: config.maxUploadBytes,
      files: 1,
      fields: 10,
      fieldSize: 1024,
      parts: 20,
      headerPairs: 100,
    },
  });

  if (config.apiDocsEnabled) {
    await app.register(fastifySwagger, {
      openapi: {
        info: {
          title: 'AI Document Intelligence API',
          description: 'Invoice ingestion, extraction and classification',
          version: '0.1.0',
        },
      },
      transform: jsonSchemaTransform,
    });
    await app.register(fastifySwaggerUi, { routePrefix: '/docs' });
  }

  app.get(
    '/health',
    {
      schema: {
        summary: 'Liveness check',
        tags: ['health'],
        response: { 200: z.object({ status: z.literal('ok') }) },
      },
    },
    () => ({ status: 'ok' as const }),
  );

  const services = createServices(config, createLocalAdapters(options.adapters), app.log);
  await app.register(documentRoutes(services), { prefix: '/v1' });

  return app;
}
