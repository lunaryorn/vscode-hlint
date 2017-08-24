# VSCode HLint

[![Build Status](https://travis-ci.org/lunaryorn/vscode-hlint.svg?branch=master)](https://travis-ci.org/lunaryorn/vscode-hlint)

Lint Haskell code with [HLint][] in [Visual Studio Code][code].

[HLint]: https://github.com/ndmitchell/hlint
[code]: https://code.visualstudio.com

## Prerequisites

* [Stack](http://haskellstack.org) must be in `$PATH`.
* `hlint` **2.0.8** or newer must be available in the current stack project.  HLint 1.9.25 and upwards should work too, but I'm not testing it.  HLint 2.0.0 to 2.0.7 do **not** work—these versions can't read code from standard input.

To add hlint to a stack project run `stack build hlint` (`build`, _not_ `install`!) in the stack project.

To apply suggestions [apply-refact][] 0.3 or newer must be available in the current stack project.  If it's missing you'll see a warning message and the light bulb feature won't be available for HLint suggestions, but linting will continue to work just fine.

To add apply-refact to a stack project run `stack build apply-refact` in the top-level directory of the project.

[apply-refact]: https://github.com/mpickering/apply-refact

## Usage

Just open or save a Haskell file.  HLint will automatically check your file.

In some cases HLint can automatically fix issues.  In these cases a [code action][] is available on the problematic expression; just click on the light bulb in the left margin.

**Note:** By default most HLint hints are "suggestions".  VSCode doesn't show these in the editor; you'll need to summon the "Problems" window explicitly to see those.  You can [configure HLint][1] to change the severity of hints if you like.

[1]: https://github.com/ndmitchell/hlint#customizing-the-hints
[code action]: https://code.visualstudio.com/docs/editor/editingevolved#_code-action

## Prior Art

[Haskell Linter](https://github.com/hoovercj/vscode-haskell-linter).

I wrote this extension because the above does not currently work with HLint 2, and I found the implementation overly verbose and clumsy when trying to address the issue.  If I may say this extension has the better code: Less mutable state, much simpler implementation, and better documentation :blush:  It also uses `refactor` to apply HLint suggestions instead of text replacement.
