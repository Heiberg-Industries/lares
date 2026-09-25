import { Brand, Bracket, Mark } from "../components/Brand";
import { HeroField } from "../components/HeroField";
import { ThemeToggle } from "../components/ThemeToggle";
import { features, offerings, selectedOffering } from "../lib/content";

function Arrow({ diagonal = false }: { diagonal?: boolean }) {
  return <span aria-hidden="true">{diagonal ? "↗" : "→"}</span>;
}

function AgentSymbol({ role }: { role: "chief" | "travel" | "thinking" }) {
  return (
    <span className={`agent-symbol agent-symbol-${role}`} aria-hidden="true">
      <span />
    </span>
  );
}

export default async function Home({ searchParams }: { searchParams: Promise<{ edition?: string }> }) {
  const edition = selectedOffering((await searchParams).edition);
  return (
    <div className="marketing" id="top">
      <header className="site-header site-wrap">
        <a className="brand-link" href="#top" aria-label="Lares home"><Brand /><span className="coming mono">coming</span></a>
        <nav aria-label="Website">
          <a href="#how">How it works</a>
          <a href="#doors">Ways to get started</a>
          <a href="#list">Get on the list <Arrow diagonal /></a>
        </nav>
        <ThemeToggle />
      </header>

      <HeroField>
        <div className="hero site-wrap">
          <span className="mono eyebrow">your server. your keys. your house.</span>
          <h1>Agents that live<br />in your house.</h1>
          <p className="hero-copy">A small fleet for the everyday work of your business. Bring your inbox, calendar and follow-ups together, with clear permissions for what each agent can do.</p>
          <div className="hero-actions">
            <a className="button button-primary" href="#list">Get on the list <Arrow /></a>
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

        <section className="site-wrap product-peek" aria-labelledby="product-title">
          <div>
            <span className="mono muted">a quiet place to keep an eye on things</span>
            <h2 id="product-title">See what happened.<br />Decide what happens next.</h2>
            <p>Your agents, their work, and the decisions that need you. A small console for keeping the house in order.</p>
            <a className="button button-outline" href="https://github.com/Heiberg-Industries/lares">Read about the console <Arrow /></a>
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
                <span className="mono door-label"><Bracket /> {offering.id}</span>
                <span className="offering-subtitle">{offering.label}</span>
                <h3>{offering.title}</h3>
                <p>{offering.body}</p>
                <a href={`/?edition=${offering.id}#list`}>{offering.action} <Arrow diagonal /></a>
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

      <div className="signup-footer">
        <section className="waitlist" id="list" aria-labelledby="waitlist-title">
          <div className="site-wrap waitlist-grid">
            <div>
              <h2 id="waitlist-title">Get on the list</h2>
              <p>What would you like taken off your plate?</p>
              <p className="hint">Choose your setup and tell us where you’d start. Lares is in development; availability and pricing are still to be confirmed.</p>
              <p className="signup-preview-note">Form preview only. Nothing you enter is sent or saved.</p>
            </div>
            <form aria-label="Signup preview">
              <fieldset disabled>
                <label>Email<input type="email" placeholder="you@company.no" /></label>
                <label>How would you like to use Lares?
                  <select defaultValue={edition}>
                    <option value="domus">domus — I run it myself</option>
                    <option value="villa">villa — you run it</option>
                    <option value="familia">familia — I want the results</option>
                  </select>
                </label>
                <label>What should it help with first?<input type="text" placeholder="Chase the invoices I keep forgetting" /></label>
                <button className="button button-primary" type="button">Signups are not open yet</button>
              </fieldset>
            </form>
          </div>
        </section>
        <footer className="site-wrap site-footer">
          <span className="brand"><Mark /><span className="mono">lares · Heiberg Industries · Oslo</span></span>
          <a href="https://github.com/Heiberg-Industries/lares">Source code <Arrow diagonal /></a>
        </footer>
      </div>
    </div>
  );
}
