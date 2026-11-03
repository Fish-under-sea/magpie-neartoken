package plugin

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

// TestNearTokenCallsKept 钉住一件事：页面插件在 package.json 里声明的
// magpie.calls，必须真的穿过 callsKeeping 到窗口那边。少一条，页面只会
// 看到「NearToken doesn't ask for neartoken:state」，而不是一个能读懂的失败。
func TestNearTokenCallsKept(t *testing.T) {
	want := []string{
		"neartoken:state", "neartoken:connect", "neartoken:cancel", "neartoken:open",
		"neartoken:disconnect", "neartoken:refresh", "neartoken:usage", "neartoken:topup",
	}
	dir := t.TempDir()
	pageDir := filepath.Join(dir, "page")
	if err := os.MkdirAll(pageDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(pageDir, "index.html"), []byte("<!doctype html>"), 0o644); err != nil {
		t.Fatal(err)
	}
	pkg, err := json.Marshal(map[string]any{
		"name": "@fish-under-sea/magpie-neartoken",
		"magpie": map[string]any{
			"page":  map[string]any{"title": "NearToken", "file": "page/index.html"},
			"calls": want,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "package.json"), pkg, 0o644); err != nil {
		t.Fatal(err)
	}

	w, _ := Window(dir)
	if w == nil || w.Page == nil {
		t.Fatal("the package's page was not read")
	}
	if !slices.Equal(w.Calls, want) {
		t.Fatalf("Window().Calls = %v, want %v", w.Calls, want)
	}
	kept := callsKeeping(w.Calls)
	if !slices.Equal(kept, want) {
		t.Fatalf("callsKeeping dropped %v; PageCalls lacks them", want)
	}
	// 不在这张表里的名字仍然被丢掉：白名单的意义不能因为加了 NearToken 就没了
	if got := callsKeeping([]string{"neartoken:state", "neartoken:delete-everything"}); slices.Contains(got, "neartoken:delete-everything") {
		t.Errorf("an undeclared call was kept: %v", got)
	}
}
