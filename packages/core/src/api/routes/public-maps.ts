// Side-effect import: @fastify/swagger augments FastifySchema with `description`.
import '@fastify/swagger';
import type { FastifyInstance } from 'fastify';
import { MapError } from '../../maps/errors.js';
import type { MapResolver } from '../../maps/resolver.js';
import type { MapService } from '../../maps/service.js';
import type { ShareRateLimit } from '../../maps/shares.js';
import { PUBLIC } from '../authorization.js';

/**
 * The one unauthenticated surface in this system (`G-06`, `ADR-002` Decision 1).
 *
 * **Its own file, and that is the point.** Everything under `/api/v1/public/` is reachable with no
 * session, so "what can a stranger see?" is answerable by reading one file and one path prefix
 * rather than by auditing a `config: PUBLIC` scattered among two hundred routes. The
 * authentication hook exempts the prefix; nothing else may be registered here.
 *
 * **The token is the authorisation, and it authorises one map's already-chosen widgets.** No
 * object id is accepted, no tree is walked, nothing drills through to a sensor page. A viewer
 * holding the link sees the dashboard somebody built and has no way to ask a question the
 * dashboard does not already answer — which is what makes the blast radius of a leaked link
 * something the person who made it can reason about.
 *
 * **What it still leaks, said out loud**: hostnames, sensor names, what is failing, and the shape
 * of the canvas. The sharing UI says so at the point of sharing, because an operator turning this
 * on is making that trade.
 */

export interface PublicMapRouteOptions {
  maps: MapService;
  resolver: MapResolver;
  limit: ShareRateLimit;
  /** Served to a stranger only when the map opted in (`ADR-004` Decision 4). */
  tiles?: { urlTemplate: string; attribution: string };
}

/**
 * The prefix the authentication hook exempts.
 *
 * A prefix rather than an exact path, because the token is *in* the path. That is a bigger hammer
 * than the exact-match list `ALWAYS_PUBLIC` uses, so it is narrow on purpose: one namespace whose
 * only inhabitants are the routes below, which makes an accidental public route obvious in the
 * route table rather than invisible in a config flag.
 */
export const PUBLIC_MAP_PREFIX = '/api/v1/public/';

/** Bounded, because it is a caller-supplied string used as a rate-limit key. */
const MAX_TOKEN_LENGTH = 100;

const forbidden = (): MapError =>
  // **The same answer for expired, revoked, and never-existed.** Telling them apart tells a
  // caller which of their guesses was once a real link, which is the only useful signal a
  // brute-forcer could get from this route.
  new MapError('MAP_NOT_FOUND', 'this link is not valid', {
    context: { phase: 'public-map' },
  });

export function publicMapRoutes(app: FastifyInstance, options: PublicMapRouteOptions): void {
  const { maps, resolver, limit } = options;
  const tiles = options.tiles ?? { urlTemplate: '', attribution: '' };

  /**
   * Bounded per link, before any database work.
   *
   * The caller's *address* is already bounded by the global limiter, which keys unauthenticated
   * requests by address; what it cannot see is the link, and a URL posted somewhere public is hit
   * from a thousand addresses that are each within their own budget.
   */
  const within = (token: string): boolean => limit.allow(`token:${token}`);

  app.get<{ Params: { token: string } }>(
    '/public/maps/:token',
    {
      config: PUBLIC,
      schema: {
        tags: ['maps'],
        summary: 'A shared map, with no session at all',
        description:
          'The map a share token opens, with every widget resolved. Expired, revoked and ' +
          'never-existed tokens all answer 404 in the same words: telling them apart would say ' +
          'which guesses were once real links. Rate limited per address and per token.',
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'widgets', 'connectors', 'problems', 'hasBackground'],
            properties: {
              name: { type: 'string' },
              description: { type: 'string' },
              // Loose for the same reason the authenticated view route's is: a resolved widget is
              // a union whose arms differ by kind.
              widgets: { type: 'array', items: { type: 'object', additionalProperties: true } },
              connectors: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['id', 'from', 'to'],
                  properties: {
                    id: { type: 'string' },
                    from: { type: 'string' },
                    to: { type: 'string' },
                  },
                },
              },
              problems: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['id', 'problem'],
                  properties: { id: { type: 'string' }, problem: { type: 'string' } },
                },
              },
              /** So the page knows whether to ask for the image at all. */
              hasBackground: { type: 'boolean' },
              geo: {
                type: ['object', 'null'],
                additionalProperties: false,
                required: ['lat', 'lon', 'zoom', 'publicTiles'],
                properties: {
                  lat: { type: 'number' },
                  lon: { type: 'number' },
                  zoom: { type: 'integer' },
                  publicTiles: { type: 'boolean' },
                },
              },
              tiles: {
                type: ['object', 'null'],
                additionalProperties: false,
                required: ['urlTemplate', 'attribution'],
                properties: { urlTemplate: { type: 'string' }, attribution: { type: 'string' } },
              },
            },
          },
        },
      },
    },
    async (request) => {
      const token = request.params.token;
      if (token.length > MAX_TOKEN_LENGTH) throw forbidden();
      if (!within(token)) {
        throw new MapError('MAP_FORBIDDEN', 'too many requests for this link', {
          context: { phase: 'public-map' },
        });
      }

      const opened = await maps.openShare(token);
      if (opened === undefined) throw forbidden();

      // **`kind: 'public'`, which is a choice made here and nowhere else.** The resolver's
      // audience is a discriminated union precisely so this cannot happen by forgetting to pass
      // a principal (`G-02`).
      const resolved = await resolver.resolve(opened.map.layout, { kind: 'public' });
      const background = await maps.sharedBackground(token);
      // **`ADR-004` Decision 4, as one condition rather than two places.** A stranger's browser
      // fetches tiles from a third party, telling it that this installation exists and which
      // coordinates it cares about; the map's author has to have asked for that.
      const shared = resolved.geo?.publicTiles === true && tiles.urlTemplate !== '' ? tiles : null;
      return {
        name: opened.map.name,
        description: opened.map.description,
        widgets: resolved.widgets,
        connectors: resolved.connectors,
        geo: resolved.geo,
        tiles: shared,
        problems: resolved.problems,
        hasBackground: background !== undefined,
      };
    },
  );
}

/**
 * The background image behind a shared map.
 *
 * **Registered apart, for the response-schema exemption** — the same reason the authenticated
 * background route is, and it is separated here so the exemption covers bytes and not the JSON
 * route beside it.
 *
 * **`ADR-002` said one unauthenticated route and this is a second one**, which is recorded as an
 * amendment rather than done quietly. It is not a widening: the same token, the same map, and the
 * image is part of what that map looks like. The alternative — a data URI inside the JSON — would
 * put two megabytes of base64 into every poll of a wall display.
 */
export function publicMapBackgroundRoute(
  app: FastifyInstance,
  options: PublicMapRouteOptions,
): void {
  const { maps, limit } = options;
  const within = (token: string): boolean => limit.allow(`token:${token}`);

  app.get<{ Params: { token: string }; Headers: { 'if-none-match'?: string } }>(
    '/public/maps/:token/background',
    {
      config: PUBLIC,
      schema: {
        tags: ['maps'],
        summary: 'The background image behind a shared map',
        description: 'The same bytes and the same ETag as the authenticated route serves.',
      },
    },
    async (request, reply) => {
      const token = request.params.token;
      if (token.length > MAX_TOKEN_LENGTH) throw forbidden();
      if (!within(token)) {
        throw new MapError('MAP_FORBIDDEN', 'too many requests for this link', {
          context: { phase: 'public-map' },
        });
      }

      const stored = await maps.sharedBackground(token);
      if (stored === undefined) throw forbidden();

      const etag = `"${stored.digest}"`;
      reply
        .header('etag', etag)
        .header('cache-control', 'private, max-age=0, must-revalidate')
        .header('x-content-type-options', 'nosniff')
        .header('content-security-policy', "default-src 'none'")
        .header('content-disposition', 'inline');

      if (request.headers['if-none-match'] === etag) return reply.code(304).send();

      const bytes = await maps.sharedBackgroundBytes(token);
      /* c8 ignore next 3 -- the metadata row was read in the same request */
      if (bytes === undefined) throw forbidden();
      return reply.type(stored.mediaType).send(bytes);
    },
  );
}
