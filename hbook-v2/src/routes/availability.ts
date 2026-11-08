/**
 * hbook — host availability.
 *
 * Weekly schedule: minutes-from-midnight windows per weekday (0=Sun..6=Sat),
 * stored in the host timezone. Date overrides close a day completely or
 * replace it with a single custom window (public holidays, one-off shifts).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { notFound, unprocessable } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { hhmmToMinutes, minutesToHHMM } from '../lib/time';
import { R } from '../schemas/core';
import {
  AvailabilityPutBody,
  AvailabilityResponse,
  DateOverrideInput,
  IdParam,
  OverrideDateParam,
} from '../schemas/resources';

interface WindowInput {
  start: string;
  end: string;
}
interface WeeklyItemInput {
  weekday: number;
  windows: WindowInput[];
}
type AvailabilityPutRequest = FastifyRequest<{ Body: { weekly: WeeklyItemInput[] } }>;
type OverrideRequest = FastifyRequest<{ Body: { date: string; closed?: boolean; start?: string; end?: string } }>;

function validateWindows(windows: WindowInput[]): { startMinute: number; endMinute: number }[] {
  const parsed = windows
    .map((w) => ({ startMinute: hhmmToMinutes(w.start), endMinute: hhmmToMinutes(w.end) }))
    .sort((a, b) => a.startMinute - b.startMinute);

  for (const w of parsed) {
    if (w.startMinute >= w.endMinute) {
      throw unprocessable('INVALID_WINDOW', 'Availability window "start" must be before "end".');
    }
  }
  for (let i = 1; i < parsed.length; i++) {
    if (parsed[i].startMinute < parsed[i - 1].endMinute) {
      throw unprocessable('WINDOWS_OVERLAP', 'Availability windows of the same weekday must not overlap.');
    }
  }
  return parsed;
}

async function availabilityResponse(userId: string, timezone: string) {
  const [rows, overrides] = await Promise.all([
    prisma.availability.findMany({
      where: { userId },
      orderBy: [{ weekday: 'asc' }, { startMinute: 'asc' }],
    }),
    prisma.dateOverride.findMany({
      where: { userId },
      orderBy: { date: 'asc' },
    }),
  ]);

  const weeklyMap = new Map<number, { weekday: number; windows: { start: string; end: string }[] }>();
  for (const r of rows) {
    const item = weeklyMap.get(r.weekday) ?? { weekday: r.weekday, windows: [] };
    item.windows.push({ start: minutesToHHMM(r.startMinute), end: minutesToHHMM(r.endMinute) });
    weeklyMap.set(r.weekday, item);
  }

  return {
    userId,
    timezone,
    weekly: [...weeklyMap.values()],
    overrides: overrides.map((o) => ({
      date: o.date.toISOString().slice(0, 10),
      closed: o.isClosed,
      windows:
        !o.isClosed && o.startMinute !== null && o.endMinute !== null
          ? [{ start: minutesToHHMM(o.startMinute), end: minutesToHHMM(o.endMinute) }]
          : [],
    })),
  };
}

export default async function availabilityRoutes(fastify: FastifyInstance): Promise<void> {
  const requireScope = fastify.requireScope.bind(fastify);

  fastify.get(
    '/users/:id/availability',
    {
      preHandler: requireScope('read'),
      schema: {
        summary: "Get a host's weekly availability + date overrides",
        tags: ['Availability'],
        security: [{ ApiKeyAuth: [] }],
        params: R('IdParam'),
        response: { 200: R('AvailabilityResponse'), 404: R('Error') },
      },
    },
    async (req) => {
      const user = await prisma.user.findFirst({
        where: { id: (req.params as { id: string }).id, tenantId: req.tenant!.id },
      });
      if (!user) throw notFound('User');
      return availabilityResponse(user.id, user.timezone || req.tenant!.timezone);
    },
  );

  fastify.put(
    '/users/:id/availability',
    {
      preHandler: requireScope('manage'),
      schema: {
        summary: "Replace a host's weekly availability (idempotent full update)",
        tags: ['Availability'],
        security: [{ ApiKeyAuth: [] }],
        params: R('IdParam'),
        body: R('AvailabilityPutBody'),
        response: { 200: R('AvailabilityResponse'), 404: R('Error'), 422: R('Error') },
      },
    },
    async (req, _reply) => {
      const { weekly } = (req as unknown as AvailabilityPutRequest).body;
      const user = await prisma.user.findFirst({
        where: { id: (req.params as { id: string }).id, tenantId: req.tenant!.id },
      });
      if (!user) throw notFound('User');

      const rows: { userId: string; tenantId: string; weekday: number; startMinute: number; endMinute: number }[] = [];
      const seenWeekdays = new Set<number>();
      for (const item of weekly) {
        if (seenWeekdays.has(item.weekday)) {
          throw unprocessable('DUPLICATE_WEEKDAY', `Weekday ${item.weekday} appears more than once — merge its windows.`);
        }
        seenWeekdays.add(item.weekday);
        for (const w of validateWindows(item.windows)) {
          rows.push({ userId: user.id, tenantId: req.tenant!.id, weekday: item.weekday, ...w });
        }
      }

      await prisma.$transaction([
        prisma.availability.deleteMany({ where: { userId: user.id } }),
        prisma.availability.createMany({ data: rows }),
      ]);

      return availabilityResponse(user.id, user.timezone || req.tenant!.timezone);
    },
  );

  fastify.post(
    '/users/:id/availability/overrides',
    {
      preHandler: requireScope('manage'),
      schema: {
        summary: 'Add/update a date override (day off or custom window)',
        tags: ['Availability'],
        security: [{ ApiKeyAuth: [] }],
        params: R('IdParam'),
        body: R('DateOverrideInput'),
        response: { 201: R('AvailabilityResponse'), 404: R('Error'), 422: R('Error') },
      },
    },
    async (req, reply) => {
      const user = await prisma.user.findFirst({
        where: { id: (req.params as { id: string }).id, tenantId: req.tenant!.id },
      });
      if (!user) throw notFound('User');

      const b = (req as unknown as OverrideRequest).body;
      const closed = b.closed ?? true;
      let startMinute: number | null = null;
      let endMinute: number | null = null;

      if (!closed) {
        if (!b.start || !b.end) {
          throw unprocessable('OVERRIDE_WINDOW_REQUIRED', 'For a working override pass "closed": false plus "start"/"end".');
        }
        const [w] = validateWindows([{ start: b.start, end: b.end }]);
        startMinute = w.startMinute;
        endMinute = w.endMinute;
      }

      await prisma.dateOverride.upsert({
        where: { userId_date: { userId: user.id, date: new Date(`${b.date}T00:00:00.000Z`) } },
        create: {
          tenantId: req.tenant!.id,
          userId: user.id,
          date: new Date(`${b.date}T00:00:00.000Z`),
          isClosed: closed,
          startMinute,
          endMinute,
        },
        update: { isClosed: closed, startMinute, endMinute },
      });

      return reply.status(201).send(await availabilityResponse(user.id, user.timezone || req.tenant!.timezone));
    },
  );

  fastify.delete(
    '/users/:id/availability/overrides/:date',
    {
      preHandler: requireScope('manage'),
      schema: {
        summary: 'Remove a date override (day falls back to the weekly schedule)',
        tags: ['Availability'],
        security: [{ ApiKeyAuth: [] }],
        params: R('OverrideDateParam'),
        response: { 200: R('AvailabilityResponse'), 404: R('Error') },
      },
    },
    async (req) => {
      const p = req.params as { id: string; date: string };
      const user = await prisma.user.findFirst({
        where: { id: p.id, tenantId: req.tenant!.id },
      });
      if (!user) throw notFound('User');

      const removed = await prisma.dateOverride.deleteMany({
        where: { userId: user.id, date: new Date(`${p.date}T00:00:00.000Z`) },
      });
      if (removed.count === 0) throw notFound('Date override');

      return availabilityResponse(user.id, user.timezone || req.tenant!.timezone);
    },
  );
}
