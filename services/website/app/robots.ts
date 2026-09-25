import type { MetadataRoute } from 'next';
export const dynamic = 'force-static';
export default function robots(): MetadataRoute.Robots {
  const live = process.env.NEXT_PUBLIC_SITE_INDEXABLE === 'true';
  return { rules: { userAgent: '*', ...(live ? { allow: '/' } : { disallow: '/' }) }, ...(live ? { sitemap: 'https://lares.is/sitemap.xml' } : {}) };
}
