import { useId, useState, type ReactNode } from "react";
import { ArrowRight, ArrowUpRight, Pause, Play } from "lucide-react";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "./components/ui/select";
import { Mark, Bracket, Field, AgentBadge } from "./App";
function Grain({
  children,
  door = false,
}: {
  children: ReactNode;
  door?: boolean;
}) {
  const id = useId();
  const [paused, setPaused] = useState(false);
  return (
    <div
      className={`grain ${door ? "grain-door" : "hero-field"} ${paused ? "motion-paused" : ""}`}
    >
      <div className="gradient-light light-one" aria-hidden="true" />
      <div className="gradient-light light-two" aria-hidden="true" />
      <div className="surface-texture" aria-hidden="true" />
      <svg aria-hidden="true">
        <filter id={id}>
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.85"
            numOctaves="2"
            stitchTiles="stitch"
          />
          <feColorMatrix type="saturate" values="0" />
        </filter>
        <rect width="100%" height="100%" filter={`url(#${id})`} />
      </svg>
      <div className="grain-content">{children}</div>
      {!door && (
        <button
          className="hero-motion-control"
          onClick={() => setPaused(!paused)}
          aria-label={
            paused ? "Play background animation" : "Pause background animation"
          }
          aria-pressed={paused}
        >
          {paused ? <Play size={14} /> : <Pause size={14} />}
          <span>{paused ? "Play motion" : "Pause motion"}</span>
        </button>
      )}
    </div>
  );
}
export function Marketing({ openConsole }: { openConsole: () => void }) {
  const [sent, setSent] = useState(false),
    [door, setDoor] = useState("domus");
  return (
    <div className="marketing">
      <header className="site-header site-wrap">
        <a href="#marketing" className="brand">
          <Mark />
          lares<span className="coming mono">coming</span>
        </a>
        <nav aria-label="Website">
          <a href="#how">How it works</a>
          <a href="#doors">Ways to get started</a>
          <a href="#list">
            Get on the list <ArrowUpRight size={14} />
          </a>
        </nav>
      </header>
      <Grain>
        <div className="hero site-wrap enter">
          <span className="mono muted">
            your server. your keys. your house.
          </span>
          <h1>
            Agents that live
            <br />
            in your house.
          </h1>
          <p className="hero-copy">
            A small fleet for the everyday work of your business. Bring your
            inbox, calendar and follow-ups together, with clear permissions for
            what each agent can do.
          </p>
          <div className="hero-actions">
            <Button asChild className="hero-primary">
              <a href="#list">
                Get on the list <ArrowRight />
              </a>
            </Button>
            <Button variant="ghost" onClick={openConsole}>
              Explore the console <ArrowUpRight />
            </Button>
          </div>
          <p className="mono hero-note">
            In development. Try the sample console and tell us what you need.
          </p>
        </div>
      </Grain>
      <section className="site-wrap features" id="how">
        <h2>
          <Bracket />
          What it does before you ask
        </h2>
        <div className="feature-grid">
          {[
            [
              "It comes to you",
              "Start with a brief of your inbox, upcoming plans and the decisions that need you.",
            ],
            [
              "It asks first",
              "Review an action before it goes out. Set what each agent may do, and when it must ask.",
            ],
            [
              "It lives in your house",
              "Your server, your keys, your data. Read the code and decide what it may touch.",
            ],
            [
              "Make each agent yours",
              "Choose a purpose, give it a name, and set its access. Keep its work and permissions in one place.",
            ],
          ].map(([title, body], i) => (
            <article key={title}>
              <span className="mono muted">0{i + 1}</span>
              <h3>{title}</h3>
              <p>{body}</p>
            </article>
          ))}
        </div>
      </section>
      <section className="site-wrap product-peek">
        <div>
          <span className="mono muted">
            a quiet place to keep an eye on things
          </span>
          <h2>
            See what happened.
            <br />
            Decide what happens next.
          </h2>
          <p>
            Your agents, their work, and the decisions that need you. A small
            console for keeping the house in order.
          </p>
          <Button variant="outline" onClick={openConsole}>
            Try the sample console <ArrowRight />
          </Button>
        </div>
        <div className="mini-console">
          <div className="mini-header">
            <span className="brand">
              <Mark />
              lares
            </span>
            <span className="mono muted">sample</span>
          </div>
          <h3>Needs your attention</h3>
          <div className="mini-draft">
            <span className="mini-identity">
              <AgentBadge agent={{ name: "Saga", role: "Chief of staff" }} />
              <span>
                Saga <span className="muted">· email draft</span>
              </span>
              <span className="approval-label">Needs you</span>
            </span>
            <p>Send the meeting follow-up to Kari?</p>
            <Button size="sm" variant="outline" onClick={openConsole}>
              Review in console <ArrowRight />
            </Button>
          </div>
          <div className="mini-agent">
            <span>
              <AgentBadge
                agent={{ name: "Marcel", role: "Travel assistant" }}
              />
              Marcel
            </span>
            <span className="mono muted">calendar checked</span>
          </div>
          <div className="mini-agent">
            <span>
              <AgentBadge
                agent={{ name: "Calliope", role: "Thinking partner" }}
              />
              Calliope
            </span>
            <span className="mono muted">notes up to date</span>
          </div>
        </div>
      </section>
      <section id="doors" className="site-wrap doors">
        <div className="section-heading">
          <h2>Three ways in.</h2>
          <span className="mono muted">
            one fleet. different levels of help.
          </span>
        </div>
        <div className="door-grid">
          {[
            [
              "domus",
              "Take the code home.",
              "For people who want to host and configure Lares themselves. Your infrastructure, your model keys, your rules.",
              "Register interest",
            ],
            [
              "villa",
              "We run it. You read the brief.",
              "For people who want their own fleet, with help setting it up and keeping it running.",
              "Discuss hosting",
            ],
            [
              "familia",
              "Leave the everyday work to us.",
              "For people who want help shaping the workflows as well as running the agents. We work with you on what needs doing.",
              "Get in touch",
            ],
          ].map(([name, title, body, cta]) => (
            <Grain key={name} door>
              <article>
                <span className="mono door-label">
                  <Bracket />
                  {name}
                </span>
                <span className="offering-subtitle">
                  {name === "domus"
                    ? "Run it yourself"
                    : name === "villa"
                      ? "Hosted for you"
                      : "Managed service"}
                </span>
                <h2>{title}</h2>
                <p>{body}</p>
                <a href="#list" onClick={() => setDoor(name)}>
                  {cta}
                  <ArrowUpRight size={15} />
                </a>
              </article>
            </Grain>
          ))}
        </div>
      </section>
      <section className="site-wrap name-story">
        <div>
          <span className="mono muted">the name</span>
          <p>
            The Roman lares were the spirits that kept a house running and kept
            bad things out. They were tended daily and never worshipped; the
            shrine was a practical fixture in the wall, a config file. A Greek{" "}
            <em>daimon</em> became a Unix <em>daemon</em>. Lares are trusted
            daemons in your house.
          </p>
        </div>
      </section>
      <div className="signup-footer">
        <section className="waitlist" id="list">
          <div className="site-wrap waitlist-grid">
            <div>
              <h2>Get on the list</h2>
              <p>What would you like taken off your plate?</p>
              <p className="hint">
                Choose your setup and tell us where you’d start. Lares is in
                development; availability and pricing are still to be confirmed.
              </p>
              <p className="signup-preview-note">
                Preview only. Nothing you enter is sent or saved.
              </p>
            </div>
            {sent ? (
              <div className="enter">
                <Mark />
                <h3>That’s how the form will feel.</h3>
                <p>No details were sent. This is a local preview.</p>
                <Button variant="outline" onClick={() => setSent(false)}>
                  Try again
                </Button>
              </div>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  setSent(true);
                }}
              >
                <Field label="Email">
                  <Input
                    aria-label="Email"
                    type="email"
                    required
                    placeholder="you@company.no"
                  />
                </Field>
                <Field label="How would you like to use Lares?">
                  <Select value={door} onValueChange={setDoor}>
                    <SelectTrigger aria-label="How would you like to use Lares?">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="domus">
                        domus — I run it myself
                      </SelectItem>
                      <SelectItem value="villa">villa — you run it</SelectItem>
                      <SelectItem value="familia">
                        familia — I want the results
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="What should it help with first?">
                  <Input placeholder="Chase the invoices I keep forgetting" />
                </Field>
                <Button type="submit">
                  Preview signup <ArrowRight />
                </Button>
              </form>
            )}
          </div>
        </section>
        <footer className="site-wrap site-footer">
          <span className="brand">
            <Mark />
            <span className="mono">lares · Heiberg Industries · Oslo</span>
          </span>
          <button onClick={openConsole}>
            Explore console <ArrowUpRight size={14} />
          </button>
        </footer>
      </div>
    </div>
  );
}
