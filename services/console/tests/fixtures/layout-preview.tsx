/** Local Vite screenshot fixture only; never a production route.
 * pnpm -C services/console exec vite --host 127.0.0.1
 * Open /tests/fixtures/layout-preview.html?width=wide|narrow
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Choice, Field, FieldGroup, Notice, Page, PageHeader } from '@lares/ui/patterns';
import { Button } from '@lares/ui/primitives/button';
import { Checkbox, Radio } from '@lares/ui/primitives/checkbox';
import { Input } from '@lares/ui/primitives/input';
import { Select } from '@lares/ui/primitives/select';
import { Textarea } from '@lares/ui/primitives/textarea';
import styles from '../../components/AppShell.module.css';
import '../../app/utilities.css';
import '@lares/ui/console.css';
import '../../app/globals.css';

const width = new URLSearchParams(location.search).get('width') === 'narrow' ? 'narrow' : 'wide';
createRoot(document.getElementById('root')!).render(<div className={styles.shell}>
  <aside className={styles.sidebar}><span className={styles.brand}>Lares</span></aside>
  <main className={styles.main}><div className={styles.content}>
    <Page width={width} className="lares-stack">
      <PageHeader title="Synthetic page" description="Sample content for reviewing the shared grid and controls." actions={<Button variant="outline">Secondary</Button>} />
      <section className="lares-surface"><h2 className="lares-section-title">A section</h2><p>Every section fills the page, so the edges line up from top to bottom.</p></section>
      <Notice>A notice takes the same width.</Notice>
      <section className="lares-surface lares-stack"><h2 className="lares-section-title">Controls</h2>
        <Field label="A dropdown"><Select defaultValue="b"><option value="a">First choice</option><option value="b">Second choice</option></Select></Field>
        <Field label="A text field" hint="A hint sits under its control."><Input placeholder="Sample" /></Field>
        <Field label="A date"><Input type="datetime-local" /></Field>
        <Field label="A text box"><Textarea defaultValue="Longer text goes here." /></Field>
        <FieldGroup legend="A group of choices"><Choice><Checkbox defaultChecked />One</Choice><Choice><Checkbox />Two</Choice><Choice><Radio name="sample" defaultChecked />Three</Choice><Choice><Radio name="sample" />Four</Choice></FieldGroup>
        <Button>Save</Button>
      </section>
    </Page>
  </div></main>
</div>);
