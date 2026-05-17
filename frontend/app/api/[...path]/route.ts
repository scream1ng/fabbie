import { NextRequest, NextResponse } from "next/server";

const BACKEND = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

async function proxy(request: NextRequest, params: { path: string[] }) {
  const path = params.path.join("/");
  const url = `${BACKEND}/api/${path}${request.nextUrl.search}`;
  console.log("[proxy]", request.method, url);
  const body = ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer();
  const headers = new Headers(request.headers);
  headers.delete("host");

  const res = await fetch(url, { method: request.method, headers, body });
  const resBody = await res.arrayBuffer();
  const resHeaders = new Headers(res.headers);
  resHeaders.delete("content-encoding");

  return new NextResponse(resBody, { status: res.status, headers: resHeaders });
}

export async function GET(request: NextRequest, { params }: { params: { path: string[] } }) {
  return proxy(request, params);
}

export async function POST(request: NextRequest, { params }: { params: { path: string[] } }) {
  return proxy(request, params);
}
