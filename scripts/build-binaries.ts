await Bun.build({
  entrypoints: ["./src/bin/dlm.ts"],
  target: "bun",
  compile: {
    outfile: "./dist/dlm",
  },
});

await Bun.build({
  entrypoints: ["./src/bin/dlmd.ts"],
  target: "bun",
  compile: {
    outfile: "./dist/dlmd",
  },
});

