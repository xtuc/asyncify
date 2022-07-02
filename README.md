# Asyncify

This is a JavaScript wrapper intended to be used with Asyncify feature of Binaryen.

Together, they allow to use asynchronous APIs (such as most Web APIs) from within WebAssembly written and compiled from any source language.

## About this fork

Asyncify relies on a reserved space in memory to save and restore the program's stack for async operations.

The [original version of Asyncify] is hardcoding the reserved stack space's size to 1024 bytes and at a specific location.
If the stack of your program exceeded 1024 bytes it would run into a trap.

This fork allows the user to customize where and how large the Asyncify stack space is (see WebAssembly side usage).

## Usage

### WebAssembly side

Allocate the Asyncify stack space (statically or dynamically) and expose its location / size with `get_asyncify_stack_space_ptr` / `get_asyncify_stack_space_size` functions respectively:

```rust
/// Arbitrary stack size of 50kib.
const ASYNCIFY_STACK_SIZE: usize = 50 * 1024;
/// Scratch space used by Asyncify to save/restore stacks.
static ASYNCIFY_STACK: [u8; ASYNCIFY_STACK_SIZE] = [0; ASYNCIFY_STACK_SIZE];

#[no_mangle]
extern "C" fn get_asyncify_stack_space_ptr() -> i32 {
    ASYNCIFY_STACK.as_ptr() as i32
}

#[no_mangle]
extern "C" fn get_asyncify_stack_space_size() -> i32 {
    ASYNCIFY_STACK_SIZE as i32
}
```

Import and use required APIs as regular synchronous FFI functions in your code.

After the code is compiled to WebAssembly, post-process it using `wasm-opt` from the [Binaryen toolchain](https://github.com/WebAssembly/binaryen):

```shell
wasm-opt --asyncify [-O] [--pass-arg=asyncify-imports@module1.func1,...] in.wasm -o out.wasm
```

### JavaScript side

First, import asyncify via:

```javascript
import * as Asyncify from 'https://unpkg.com/asyncify-wasm?module';
```

Compilation / instantiation APIs are designed to be drop-in replacements for those of regular `WebAssembly` interface, but with `async` support.

Then, you can use `new Asyncify.Instance`, `Asyncify.instantiate` and `Asyncify.instantiateStreaming` like you would with corresponding `WebAssembly` functions, but with added support for `async` imports and all exports wrapped into async functions, too.

For example:

```js
let { instance } = await Asyncify.instantiateStreaming(fetch('./out.wasm'), {
  get_resource_text: async url => {
    let response = await fetch(readWasmString(instance, url));
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return passStringToWasm(instance, await response.text());
  }
});

await instance.exports._start();
```

[original version of Asyncify]: https://github.com/GoogleChromeLabs/asyncify
