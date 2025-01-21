# bun-pr

Download a build of bun from a pull request in bun's github repository and add it to $PATH.

### For Windows
>You must run this script from the shell with `administrator` rights. Otherwise, you will get the error `"EPERM"` when creating a symlink.

### How to use

```sh
bunx bun-pr jarred/process-change
```

This outputs:

```sh
Searching GitHub for artifact bun-darwin-aarch64 from PR #8456...
Downloading bun-darwin-aarch64 from PR #8456 - https://github.com/oven-sh/bun/actions/runs/8166869540
Downloaded to:

/Users/jarred/.bun/bin/bun-b8a2ef88f12626706f03d051e4026309f0d61ed0-pr8456

To run the downloaded executable, use any of the following following commands:

bun-b8a2ef88f12626706f03d051e4026309f0d61ed0-pr8456
bun-8456
bun-latest
```

It doesn't just run bun directly command because in development we often will want to attach a debugger.

This project was created using `bun init` in bun v1.0.30. [Bun](https://bun.sh) is a fast all-in-one JavaScript runtime.
