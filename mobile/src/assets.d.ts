/** A bundled picture: Metro turns the import into the asset's number, which `Image` takes as its source. */
declare module '*.png' {
  const source: number;
  export default source;
}

declare module '*.webp' {
  const source: number;
  export default source;
}
