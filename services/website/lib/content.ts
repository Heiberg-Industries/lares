export const features = [
  { title: "It comes to you", body: "Start with a brief of your inbox, upcoming plans and the decisions that need you." },
  { title: "It asks first", body: "Review an action before it goes out. Set what each agent may do, and when it must ask." },
  { title: "It lives in your house", body: "Your server, your keys, your data. Read the code and decide what it may touch." },
  { title: "Make each agent yours", body: "Choose a purpose, give it a name, and set its access. Keep its work and permissions in one place." },
] as const;

export const offerings = [
  { id: "domus", label: "Run it yourself", title: "Take the code home.", body: "Run it on your own server. Your keys, your rules, your agents.", action: "Explore the code", href: "https://github.com/Heiberg-Industries/lares" },
  { id: "villa", label: "Hosted for you", title: "We run it. You read the brief.", body: "Same fleet, on a server we set up and keep. We can talk through the setup and ongoing care.", action: "Book a call", href: "https://booking.heiberg.co/intro" },
  { id: "familia", label: "Managed service", title: "Care f**k all about agents? Get in touch.", body: "You want the results, not the machinery. Fine. It shows up in your inbox and you never have to look under the hood.", action: "Get in touch", href: "#contact" },
] as const;
