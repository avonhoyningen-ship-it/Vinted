import { redirect } from "next/navigation";
import { Landing } from "@/components/Landing";
import { CLOUD } from "@/lib/mode";

/** Cloud: public landing page. Local: straight to the dashboard. */
export default function Home() {
  if (!CLOUD) redirect("/dashboard");
  return <Landing />;
}
