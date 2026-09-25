import type { ReactNode } from 'react';
import { RootProvider } from 'fumadocs-ui/provider/next';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { source } from '../../lib/source';
import { Brand } from '../../components/Brand';
import { ThemeToggle } from '../../components/ThemeToggle';
import './docs.css';
export default function Layout({ children }: { children: ReactNode }) {
  return <RootProvider theme={{ enabled: false }} search={{ options: { type: 'static', api: '/docs-search.json' } }}>
    <DocsLayout tree={source.pageTree} nav={{ title: <Brand />, url: '/' }}
      themeSwitch={{ enabled: false }}
      links={[{ text: 'Website', url: '/' }, { text: 'GitHub', url: 'https://github.com/Heiberg-Industries/lares', external: true }]}
      sidebar={{ footer: <ThemeToggle /> }}>
      {children}
    </DocsLayout>
  </RootProvider>;
}
