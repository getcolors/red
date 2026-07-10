// Ambient declarations for template text imports (`with { type: "text" }`).
// Bun's types cover common extensions (.txt, .yml, ...); templates add these.
// A consumer project text-importing its own templates declares the same for
// whatever extensions it uses.

declare module "*.tf" {
  const text: string;
  export default text;
}

declare module "*.cfg" {
  const text: string;
  export default text;
}

declare module "*.j2" {
  const text: string;
  export default text;
}
