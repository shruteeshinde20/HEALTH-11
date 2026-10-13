// "/" until the Landing page is built (build step 14): go to the dashboard
// when signed in, otherwise to the login page.

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { cookieNames } from "@/lib/server/session-core.ts";
import { HOME_PATH } from "@/lib/shared/navigation.ts";

export default async function Home() {
  const names = cookieNames(process.env.NODE_ENV === "production");
  const store = await cookies();
  redirect(store.has(names.access) || store.has(names.refresh) ? HOME_PATH : "/login");
}
