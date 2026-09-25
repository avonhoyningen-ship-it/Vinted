import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Cloud: every page except the public ones needs a Clerk login (redirect to
 * /sign-in). The API (/api/…) checks the session itself. Local: no-op.
 */
const isPublic = createRouteMatcher(["/", "/sign-in(.*)", "/sign-up(.*)", "/impressum", "/datenschutz", "/agb", "/api/(.*)"]);

const cloud = clerkMiddleware(async (auth, req) => {
  if (!isPublic(req)) await auth.protect();
});

export default function proxy(req: NextRequest, ev: Parameters<typeof cloud>[1]) {
  if (process.env.NEXT_PUBLIC_APP_MODE !== "cloud") return NextResponse.next();
  return cloud(req, ev);
}

export const config = {
  matcher: [
    // Skip Next internals and static files
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
