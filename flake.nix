{
  description = "forum";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      utils,
    }:
    utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };
      in
      {
        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            nodejs_24
          ];
          ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
          ELECTRON_OVERRIDE_DIST_PATH = "${pkgs.electron}/libexec/electron";
        };
      }
    );
}
