declare module "bidi-js" {
  interface Bidi {
    getBidiCharTypeName(character: string): string
  }

  export default function bidiFactory(): Bidi
}
