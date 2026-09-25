import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { DocsPage, DocsBody, DocsTitle, DocsDescription } from 'fumadocs-ui/page';
import defaultMdxComponents from 'fumadocs-ui/mdx';
import { source } from '../../../lib/source';
type Props = { params: Promise<{ slug?: string[] }> };
export default async function Page({ params }: Props) {
  const { slug } = await params;
  const page = source.getPage(slug);
  if (!page) notFound();
  const MDX = page.data.body;
  return <DocsPage toc={page.data.toc}>
    <DocsTitle>{page.data.title}</DocsTitle>
    <DocsDescription>{page.data.description}</DocsDescription>
    <DocsBody><MDX components={defaultMdxComponents} /></DocsBody>
  </DocsPage>;
}
export function generateStaticParams() { return source.generateParams(); }
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const page = source.getPage((await params).slug);
  if (!page) notFound();
  return { title: `${page.data.title} — Lares docs`, description: page.data.description, alternates: { canonical: page.url } };
}
