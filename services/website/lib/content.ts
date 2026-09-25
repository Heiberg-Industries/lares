export const features = [
  { title: "It comes to you", body: "Start with a brief of your inbox, upcoming plans and the decisions that need you." },
  { title: "It asks first", body: "Review an action before it goes out. Set what each agent may do, and when it must ask." },
  { title: "It lives in your house", body: "Your server, your keys, your data. Read the code and decide what it may touch." },
  { title: "Make each agent yours", body: "Choose a purpose, give it a name, and set its access. Keep its work and permissions in one place." },
] as const;

export const offerings = [
  { id: "domus", label: "Run it yourself", title: "Take the code home.", body: "For people who want to host and configure Lares themselves. Your infrastructure, your model keys, your rules.", action: "Register interest" },
  { id: "villa", label: "Hosted for you", title: "We run it. You read the brief.", body: "For people who want their own fleet, with help setting it up and keeping it running.", action: "Discuss hosting" },
  { id: "familia", label: "Managed service", title: "Leave the everyday work to us.", body: "For people who want help shaping the workflows as well as running the agents. We work with you on what needs doing.", action: "Get in touch" },
] as const;

export type OfferingId = (typeof offerings)[number]["id"];

export function selectedOffering(value: string | undefined): OfferingId {
  return offerings.find((offering) => offering.id === value)?.id ?? "domus";
}
