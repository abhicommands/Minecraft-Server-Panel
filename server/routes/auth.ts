import { SignJWT, jwtVerify } from "jose";
import type {
  AppConfig,
  BunRouteRequest,
  RouteHandler,
  RouteTable,
  SessionUser,
} from "../types.ts";
import { jsonResponse, readJson, route } from "../utils/http.ts";
import { PASSWORD_PATTERN, USERNAME_PATTERN } from "../utils/password.ts";

interface LoginBody {
  username?: unknown;
  password?: unknown;
}

export class AuthService {
  constructor(private readonly config: AppConfig) {}

  private cookieOptions(): Bun.CookieInit {
    return {
      httpOnly: true,
      secure: this.config.secureCookie,
      sameSite: "strict",
      path: "/",
      maxAge: 604_800,
    };
  }

  async issueToken(username: string): Promise<string> {
    return new SignJWT({ username })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuedAt()
      .setExpirationTime("7d")
      .sign(this.config.jwtSecret);
  }

  async verifyToken(token: string): Promise<SessionUser> {
    const { payload } = await jwtVerify(token, this.config.jwtSecret, {
      algorithms: ["HS256"],
    });
    if (typeof payload.username !== "string" || !payload.username) {
      throw new Error("Invalid token payload");
    }
    return { username: payload.username };
  }

  async authenticate(request: Request): Promise<SessionUser> {
    const cookies = new Bun.CookieMap(request.headers.get("cookie") || "");
    const token = cookies.get("token");
    if (!token) throw new Error("Missing token");
    return this.verifyToken(token);
  }

  authenticated(
    handler: (
      request: BunRouteRequest,
      user: SessionUser,
    ) => Response | Promise<Response>,
  ): RouteHandler {
    return async (request) => {
      let user: SessionUser;
      try {
        user = await this.authenticate(request);
      } catch {
        request.cookies.delete("token", {
          path: "/",
        });
        return jsonResponse({ error: "Invalid session." }, 401);
      }
      return handler(request, user);
    };
  }

  createRoutes(): RouteTable {
    return {
      "/login": {
        POST: route(this.config, async (request) => {
          const body = await readJson<LoginBody>(request);
          if (
            typeof body.username !== "string" ||
            !USERNAME_PATTERN.test(body.username) ||
            body.username.length < 3 ||
            body.username.length > 30 ||
            typeof body.password !== "string" ||
            !PASSWORD_PATTERN.test(body.password) ||
            body.password.length < 6 ||
            body.password.length > 50
          ) {
            return jsonResponse({ error: "Invalid username or password format" }, 400);
          }

          const passwordMatches =
            body.username === this.config.rootUsername &&
            (await Bun.password.verify(body.password, this.config.rootPasswordHash));
          if (!passwordMatches) {
            return jsonResponse({ error: "Invalid username or password" }, 401);
          }

          request.cookies.set(
            "token",
            await this.issueToken(body.username),
            this.cookieOptions(),
          );
          return jsonResponse({ message: "Login successful" });
        }),
      },
      "/logout": {
        POST: route(this.config, async (request) => {
          request.cookies.delete("token", { path: "/" });
          return jsonResponse({ message: "Logout successful" });
        }),
      },
      "/validate-session": {
        GET: route(
          this.config,
          this.authenticated(async () => jsonResponse({ message: "Valid session" })),
        ),
      },
    };
  }
}
