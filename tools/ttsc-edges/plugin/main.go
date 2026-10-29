// A check-stage sidecar that writes every module resolution of the program to $TTSC_EDGES_OUT as JSON:
// the containing file, the specifier as written and the file the compiler resolved it to.
package main

import (
    "encoding/json"
    "fmt"
    "os"
    "path/filepath"
    "strings"

    shimcompiler "github.com/microsoft/typescript-go/shim/compiler"

    "github.com/samchon/ttsc/packages/ttsc/driver"
)

type edge struct {
    File      string `json:"file"`
    Specifier string `json:"specifier"`
    Resolved  string `json:"resolved"`
    Target    string `json:"target"`
}

func main() {
    if len(os.Args) < 2 {
        os.Exit(2)
    }
    switch os.Args[1] {
    case "version", "-v", "--version":
        fmt.Println("ttsc-edges 0.0.0")
    case "check":
        os.Exit(runCheck(os.Args[2:]))
    default:
        fmt.Fprintf(os.Stderr, "ttsc-edges: unknown command %q\n", os.Args[1])
        os.Exit(2)
    }
}

func runCheck(args []string) int {
    cwd, tsconfig := readFlags(args)
    out := os.Getenv("TTSC_EDGES_OUT")
    if out == "" {
        return 0
    }
    prog, _, err := driver.LoadProgram(cwd, tsconfig, driver.LoadProgramOptions{})
    if err != nil {
        fmt.Fprintf(os.Stderr, "ttsc-edges: %v\n", err)
        return 2
    }
    defer prog.Close()

    edges := []edge{}
    for _, task := range shimcompiler.ProgramResolutionTasks(prog.TSProgram) {
        if task.Kind != shimcompiler.ProgramResolutionKindModule || task.SourceFile == "" {
            continue
        }
        edges = append(edges, edge{
            File:      rel(cwd, task.SourceFile),
            Specifier: task.Name,
            Resolved:  task.ResolvedFile,
            Target:    rel(cwd, task.TargetFile),
        })
    }
    data, err := json.Marshal(edges)
    if err != nil {
        return 3
    }
    if err := os.WriteFile(out, data, 0o644); err != nil {
        return 3
    }
    return 0
}

func rel(cwd, name string) string {
    if name == "" {
        return ""
    }
    r, err := filepath.Rel(cwd, name)
    if err != nil || strings.HasPrefix(r, "..") {
        return filepath.ToSlash(name)
    }
    return filepath.ToSlash(r)
}

func readFlags(args []string) (cwd, tsconfig string) {
    tsconfig = "tsconfig.json"
    for i := 0; i < len(args); i++ {
        a := args[i]
        switch {
        case strings.HasPrefix(a, "--cwd="):
            cwd = strings.TrimPrefix(a, "--cwd=")
        case a == "--cwd" && i+1 < len(args):
            i++
            cwd = args[i]
        case strings.HasPrefix(a, "--tsconfig="):
            tsconfig = strings.TrimPrefix(a, "--tsconfig=")
        case a == "--tsconfig" && i+1 < len(args):
            i++
            tsconfig = args[i]
        }
    }
    if cwd == "" {
        cwd, _ = os.Getwd()
    }
    if !filepath.IsAbs(tsconfig) {
        tsconfig = filepath.Join(cwd, tsconfig)
    }
    return cwd, tsconfig
}
