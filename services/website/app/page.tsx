import { Brand, Bracket, GitHubMark, Mark } from "../components/Brand";
import { HeroField } from "../components/HeroField";
import { BookingButton } from "../components/Booking";
import { ThemeToggle } from "../components/ThemeToggle";
import { features, offerings } from "../lib/content";

function Arrow({ diagonal = false }: { diagonal?: boolean }) {
  return <span aria-hidden="true">{diagonal ? "↗" : "→"}</span>;
}

function AgentSymbol({ role }: { role: "chief" | "travel" | "thinking" }) {
  const points = role === 'chief' ? [[20,32],[9.6,14],[30.4,14]] : [[20,8],[32,20],[20,32],[8,20]];
  return <span className="agent-symbol" aria-hidden="true"><svg viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
    {role === 'travel' ? <><circle cx="20" cy="20" r="12" strokeDasharray="60 16" transform="rotate(-60 20 20)"/><circle cx="32" cy="20" r="2.3" fill="currentColor" stroke="none"/><path d="M8 20h11"/></> : <><circle cx="20" cy="20" r="12"/>{points.map(([cx,cy]) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="2.3" fill="currentColor" stroke="none"/>)}</>}
  </svg></span>;
}

export default function Home() {
  return (
    <div className="marketing" id="top">
      <header className="site-header site-wrap">
        <a className="brand-link" href="#top" aria-label="Lares home"><Brand /></a>
        <nav aria-label="Website">
          <a href="#how">How it works</a>
          <a href="#doors">Get started</a>
          <a href="/docs/">Docs</a>
          <a href="#contact">Contact <Arrow diagonal /></a>
        </nav>
        <div className="header-tools"><a className="github-link" href="https://github.com/Heiberg-Industries/lares" aria-label="Lares source code on GitHub" title="Source code on GitHub"><GitHubMark /></a>
        <ThemeToggle /></div>
      </header>

      <HeroField>
        <div className="hero site-wrap">
          <span className="mono eyebrow">your server. your keys. your house.</span>
          <h1>Agents that live<br />in your house.</h1>
          <p className="hero-copy">A small fleet for the everyday work of your business. Bring your inbox, calendar and follow-ups together, with clear permissions for what each agent can do.</p>
          <div className="hero-actions">
            <a className="button button-primary" href="#contact">Get in touch <Arrow /></a>
            <a className="button button-quiet" href="https://github.com/Heiberg-Industries/lares">Explore the code <Arrow diagonal /></a>
          </div>
          <p className="mono hero-note">In development. Availability and pricing are still to be confirmed.</p>
        </div>
      </HeroField>

      <main>
        <section className="site-wrap features" id="how" aria-labelledby="features-title">
          <h2 id="features-title"><Bracket /> What it does before you ask</h2>
          <div className="feature-grid">
            {features.map((feature, index) => (
              <article key={feature.title}>
                <span className="mono muted">0{index + 1}</span>
                <h3>{feature.title}</h3>
                <p>{feature.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="site-wrap product-peek" id="product" aria-labelledby="product-title">
          <div>
            <span className="mono muted">a quiet place to keep an eye on things</span>
            <h2 id="product-title">See what happened.<br />Decide what happens next.</h2>
            <p>Your agents, their work, and the decisions that need you. A small console for keeping the house in order.</p>
            <a className="button button-outline" href="/docs/console/">Read the docs <Arrow /></a>
          </div>
          <div className="mini-console" aria-label="Illustrative console example">
            <div className="mini-header"><Brand /><span className="mono muted">illustrative example</span></div>
            <h3>Needs your attention</h3>
            <div className="mini-draft">
              <div className="mini-identity"><AgentSymbol role="chief" /><span>Saga <span className="muted">· email draft</span></span><span className="approval-label">Needs you</span></div>
              <p>Send the meeting follow-up to Kari?</p>
              <span className="mini-action">Review before sending <Arrow /></span>
            </div>
            <div className="mini-agent"><span><AgentSymbol role="travel" /> Marcel</span><span className="mono muted">calendar checked</span></div>
            <div className="mini-agent"><span><AgentSymbol role="thinking" /> Calliope</span><span className="mono muted">notes up to date</span></div>
          </div>
        </section>

        <section className="site-wrap doors" id="doors" aria-labelledby="doors-title">
          <div className="section-heading"><h2 id="doors-title">Three ways in.</h2><span className="mono muted">one fleet. different levels of help.</span></div>
          <div className="door-grid">
            {offerings.map((offering) => (
              <article className="door-card" key={offering.id}>
                <svg className="door-grain" aria-hidden="true" focusable="false">
                  <filter id={`door-grain-${offering.id}`}>
                    <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" stitchTiles="stitch" />
                    <feColorMatrix type="saturate" values="0" />
                  </filter>
                  <rect width="100%" height="100%" filter={`url(#door-grain-${offering.id})`} />
                </svg>
                <span className="mono door-label"><Bracket /> {offering.id}</span>
                <span className="offering-subtitle">{offering.label}</span>
                <h3>{offering.title}</h3>
                <p>{offering.body}</p>
                {offering.id === 'villa' ? <BookingButton className="door-action" placement="villa">{offering.action} <Arrow diagonal /></BookingButton> : <a href={offering.href} data-analytics-action={offering.id === 'domus' ? 'github' : 'contact'} data-analytics-placement={offering.id}>{offering.action} <Arrow diagonal /></a>}
              </article>
            ))}
          </div>
        </section>

        <section className="site-wrap name-story" aria-labelledby="name-title">
          <div>
            <span className="mono muted" id="name-title">the name</span>
            <p>The Roman lares were the spirits that kept a house running and kept bad things out. They were tended daily and never worshipped; the shrine was a practical fixture in the wall, a config file. A Greek <em>daimon</em> became a Unix <em>daemon</em>. Lares are trusted daemons in your house.</p>
          </div>
        </section>
      </main>

      <div className="contact-footer">
        <section className="contact-sheet" id="contact" aria-labelledby="contact-title">
          <div className="site-wrap contact-grid">
            <div>
              <h2 id="contact-title">A note to the house.</h2>
              <p>Want us to set up lares for you, or have something else in mind?</p>
              <p className="hint">Tell us what you need. The code is open; setup and managed work start with a conversation.</p>
            </div>
            <div className="contact-actions">
              <a className="button button-primary" href="mailto:bendik@heiberg.co?subject=Lares%20enquiry">Ask us anything <Arrow diagonal /></a>
              <BookingButton className="button button-outline" placement="contact">Book a call <Arrow diagonal /></BookingButton>
              <p>Email opens in your mail app. Booking opens a small calendar window.</p>
            </div>
          </div>
        </section>
        <footer className="site-wrap site-footer">
          <span className="brand"><Mark /><span className="mono">lares · Heiberg Industries · Oslo<br /><a href="https://orakel.cloud/selskap/918145354">Org. no. 918 145 354</a></span></span>
          <div className="footer-links"><a href="/docs/">Docs</a><a href="/docs/privacy/">Privacy</a><a href="https://github.com/Heiberg-Industries/lares">Source code <Arrow diagonal /></a></div>
        </footer>
      </div>
    </div>
  );
}
