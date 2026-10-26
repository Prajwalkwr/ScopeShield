import type { Role } from '../config/constants';
import type { Permission } from '../domain/permissions';

/**
 * Request augmentation. `auth` and `org` are ALWAYS populated by middleware — handlers
 * must never read org, role or permissions from the body, query string or headers.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
      auth?: {
        userId: string;
        sessionId: string;
        user: { id: string; email: string; name: string; timezone: string; isDemo: boolean };
        memberships: {
          membershipId: string;
          orgId: string;
          orgName: string;
          orgSlug: string;
          role: Role;
          permissions: Permission[];
          projectScope: string[];
        }[];
      };
      org?: {
        orgId: string;
        membershipId: string;
        role: Role;
        permissions: Permission[];
        projectScope: string[];
      };
    }
  }
}
export {};
