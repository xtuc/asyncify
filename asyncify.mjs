/**
 * Copyright 2019 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const WRAPPED_EXPORTS = new WeakMap();

const State = {
  None: 0,
  Unwinding: 1,
  Rewinding: 2
};

function isPromise(obj) {
  return (
    !!obj &&
    (typeof obj === 'object' || typeof obj === 'function') &&
    typeof obj.then === 'function'
  );
}

function proxyGet(obj, transform) {
  return new Proxy(obj, {
    get: (obj, name) => transform(obj[name])
  });
}

class Asyncify {
  constructor() {
    this.value = undefined;
    this.exports = null;
    this.dataAddr = 0;
    this.dataStart = 0;
    this.dataEnd = 0;
  }

  getState() {
    return this.exports.asyncify_get_state();
  }

  assertNoneState() {
    let state = this.getState();
    if (state !== State.None) {
      throw new Error(`Invalid async state ${state}, expected 0.`);
    }
  }

  wrapImportFn(fn) {
    return (...args) => {
      if (this.exports === null) {
        console.warn(
            "Host functions called during Wasm initialization aren't supported by"
            + " Asyncify because Wasm exports are not yet available."
            + " Function " + fn.name + " is ignored."
        );
        return null;
      }
      if (this.getState() === State.Rewinding) {
        this.exports.asyncify_stop_rewind();
        return this.value;
      }
      this.assertNoneState();
      let value = fn(...args);
      if (!isPromise(value)) {
        return value;
      }
      this.exports.asyncify_start_unwind(this.dataAddr);
      this.value = value;
    };
  }

  wrapModuleImports(module) {
    return proxyGet(module, value => {
      if (typeof value === 'function') {
        return this.wrapImportFn(value);
      }
      return value;
    });
  }

  wrapImports(imports) {
    if (imports === undefined) return;

    return proxyGet(imports, (moduleImports = Object.create(null)) =>
      this.wrapModuleImports(moduleImports)
    );
  }

  wrapExportFn(fn) {
    let newExport = WRAPPED_EXPORTS.get(fn);

    if (newExport !== undefined) {
      return newExport;
    }

    newExport = async (...args) => {
      this.assertNoneState();

      let result = fn(...args);

      while (this.getState() === State.Unwinding) {
        this.exports.asyncify_stop_unwind();
        this.value = await this.value;
        this.assertNoneState();

        this.exports.asyncify_start_rewind(this.dataAddr);
        result = fn();
      }

      this.assertNoneState();

      return result;
    };

    WRAPPED_EXPORTS.set(fn, newExport);

    return newExport;
  }

  wrapExports(exports) {
    let newExports = Object.create(null);

    for (let exportName in exports) {
      let value = exports[exportName];
      if (typeof value === 'function' && !exportName.startsWith('asyncify_')) {
        value = this.wrapExportFn(value);
      }
      Object.defineProperty(newExports, exportName, {
        enumerable: true,
        value
      });
    }

    WRAPPED_EXPORTS.set(exports, newExports);

    return newExports;
  }

  init(instance, imports) {
    const { exports } = instance;

    const memory = exports.memory || (imports.env && imports.env.memory);

    this.dataAddr = exports.get_asyncify_stack_space_ptr();
    // Place actual data right after the descriptor (which is 2 * sizeof(i32) = 8 bytes).
    this.dataStart = exports.get_asyncify_stack_space_ptr() + 8;
    this.dataEnd = exports.get_asyncify_stack_space_ptr()
                 + exports.get_asyncify_stack_space_size();

    new Int32Array(memory.buffer, this.dataAddr).set([this.dataStart, this.dataEnd]);

    this.exports = this.wrapExports(exports);

    Object.setPrototypeOf(instance, Instance.prototype);
  }
}

export class Instance extends WebAssembly.Instance {
  constructor(module, imports) {
    let state = new Asyncify();
    super(module, state.wrapImports(imports));
    state.init(this, imports);
  }

  get exports() {
    return WRAPPED_EXPORTS.get(super.exports);
  }
}

Object.defineProperty(Instance.prototype, 'exports', { enumerable: true });

export async function instantiate(source, imports) {
  let state = new Asyncify();
  let result = await WebAssembly.instantiate(
    source,
    state.wrapImports(imports)
  );
  state.init(
    result instanceof WebAssembly.Instance ? result : result.instance,
    imports
  );
  return result;
}

export async function instantiateStreaming(source, imports) {
  let state = new Asyncify();
  let result = await WebAssembly.instantiateStreaming(
    source,
    state.wrapImports(imports)
  );
  state.init(result.instance, imports);
  return result;
}
