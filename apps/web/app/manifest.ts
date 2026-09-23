import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Vinted Dashboard",
    short_name: "Vinted",
    start_url: "/",
    display: "standalone",
    background_color: "#f6f6f4",
    theme_color: "#007782",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
