import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { env } from '../config/env';
import { notFound } from './errors';
import { LIMITS } from '../config/constants';

/** Wraps an async handler so rejected promises reach the error middleware (Express 5 does this too, but explicit is safer). */
export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    void fn(req, res, next).catch(next);
  };
}

export interface Pagination {
  page: number;
  pageSize: number;
  skip: number;
}

export function parsePagination(query: Record<string, unknown>): Pagination {
  const page = Math.max(1, Number(query.page ?? 1) || 1);
  const rawSize = Number(query.pageSize ?? LIMITS.pageSizeDefault) || LIMITS.pageSizeDefault;
  const pageSize = Math.min(Math.max(1, rawSize), LIMITS.pageSizeMax);
  return { page, pageSize, skip: (page - 1) * pageSize };
}

export function paginated<T>(items: T[], total: number, pagination: Pagination) {
  return {
    items,
    page: pagination.page,
    pageSize: pagination.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pagination.pageSize)),
  };
}

/** Absolute URL of a web-app route, used in emails and links. */
export function webUrl(path: string): string {
  return `${env.webPublicUrl.replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
}

/** Guards against unexpected query operators arriving from JSON bodies. */
export function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw notFound(`${field} is required.`);
  return value.trim();
}
