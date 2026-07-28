import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { type AuthService, type LoginSession, sessionToken } from "./service.js";

const credentials = z.object({
  username: z.string().trim().min(1).max(80),
  password: z.string().min(1).max(1_024),
});

function secureRequest(request: FastifyRequest): boolean {
  return request.protocol === "https";
}

function sendSession(
  reply: FastifyReply,
  request: FastifyRequest,
  authService: AuthService,
  session: LoginSession,
): FastifyReply {
  return reply
    .header("Set-Cookie", authService.sessionCookie(session.token, secureRequest(request)))
    .send({ user: session.user });
}

export async function authRoutes(
  app: FastifyInstance,
  { authService }: { authService: AuthService },
): Promise<void> {
  app.post("/api/auth/login", async (request, reply) => {
    const body = credentials.parse(request.body);
    const session = authService.login(body.username, body.password);
    if (!session) {
      return reply.code(401).send({ error: "Username or password is incorrect" });
    }
    return sendSession(reply, request, authService, session);
  });

  app.post("/api/auth/register", async (request, reply) => {
    const body = credentials.parse(request.body);
    const session = authService.register(body.username, body.password);
    if (!session) return reply.code(409).send({ error: "That username is already taken" });
    return sendSession(reply.code(201), request, authService, session);
  });

  app.get("/api/auth/session", async (request, reply) => {
    const user = authService.userForToken(sessionToken(request.headers.cookie));
    if (!user) return reply.code(401).send({ error: "Sign in required" });
    return { user };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    authService.endSession(sessionToken(request.headers.cookie));
    return reply
      .header("Set-Cookie", authService.clearSessionCookie(secureRequest(request)))
      .code(204)
      .send();
  });
}
