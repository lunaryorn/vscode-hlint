# Change Log
All notable changes to the "hlint" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how
to structure this file.  This project does **not** adhere to [Semantic
Versioning](http://semver.org/)!

## [Unreleased]
### Added
- Lint documents on the fly when changed

### Changed
- The extension now fails to activate if HLint is not present or if the HLint
  version does not meet the requirements of this extension (see below).

## 0.3.2 – 2017-05-28
### Changed
- Require HLint >=2.0.8 or HLint < 2 and >= 1.9.25 because the extension now
  feeds document contents to HLint on standard input which only works in the
  aforementioned versions.

### Fixed
- Only lint Haskell files.  I simply forgot this check 🙈

## 0.3.1 – 2017-05-22
### Added
- Add more metadata for the marketplace side

## 0.3.0 – 2017-05-22
### Changed
- Improve title of quick fixes
- Apply quick fixes as workspace edit, for better undo and more reliable text
  replacement [GH-2]

## 0.2.0 - 2017-05-21
### Added
- Apply suggestions from HLint (requires
  [apply-refact](https://github.com/mpickering/apply-refact))

### Fixed
- Properly unset diagnostics

## 0.1.0 - 2017-05-21
- Initial release
