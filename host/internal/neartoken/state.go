package neartoken

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/yetone/magpie/internal/appdir"
)

// snapshot 是磁盘上留着的那一份状态：密钥在 providers.json 里，这里只放
// 重启后还想显示的账户数字与未完成的授权。读不出来就当作没有，绝不拿一份
// 坏文件覆盖上一次的好数字。
type snapshot struct {
	BaseURL    string    `json:"baseURL,omitempty"`
	TokenName  string    `json:"tokenName,omitempty"`
	Account    *Account  `json:"account,omitempty"`
	Pending    *pending  `json:"pending,omitempty"`
	Error      string    `json:"error,omitempty"`
	GrantedAt  int64     `json:"grantedAt,omitempty"`
	WalletAt   int64     `json:"walletAt,omitempty"`
	Currency   *Currency `json:"currency,omitempty"`
	CurrencyAt int64     `json:"currencyAt,omitempty"`
	CatalogAt  int64     `json:"catalogAt,omitempty"`
	Models     int       `json:"models,omitempty"`
	Groups     int       `json:"groups,omitempty"`
}

// pending 是一次进行中的授权里能给人看的部分；device_code 从不落盘。
type pending struct {
	UserCode                string `json:"userCode"`
	VerificationURI         string `json:"verificationUri"`
	VerificationURIComplete string `json:"verificationUriComplete"`
	ExpiresAt               int64  `json:"expiresAt"`
}

// StatePath 是这份快照的位置，与 providers.json 同目录。
func StatePath() string { return filepath.Join(appdir.Config(), "neartoken.json") }

// loadSnapshot 读回上一次的状态；文件不存在或解不开都是空状态。
func loadSnapshot(path string) snapshot {
	b, err := os.ReadFile(path)
	if err != nil {
		return snapshot{}
	}
	var s snapshot
	if err := json.Unmarshal(b, &s); err != nil {
		return snapshot{}
	}
	return s
}

// storeSnapshot 原子地写：临时文件、落盘、改名，并留一份 .bak。
func storeSnapshot(path string, s snapshot) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	if old, err := os.ReadFile(path); err == nil {
		_ = os.WriteFile(path+".bak", old, 0o644)
	}
	if err := os.Rename(tmp, path); err != nil {
		return err
	}
	return nil
}

// saveMu 让两次保存不会互相盖掉：一次调用的写与后台刷新撞上时，最后写完的
// 那份仍是内存里最新的状态。
var saveMu sync.Mutex

// save 把当前状态写到 disk。错误只在日志里说：写不进去不该让一次连接失败。
func (m *Manager) save() {
	m.mu.Lock()
	s := m.snap
	m.mu.Unlock()
	saveMu.Lock()
	defer saveMu.Unlock()
	if err := storeSnapshot(m.path, s); err != nil && !errors.Is(err, os.ErrNotExist) {
		m.logf("saving %s: %v", m.path, err)
	}
}

// now 是这只表用的时钟；测试会换掉它。
func (m *Manager) clock() time.Time {
	if m.now != nil {
		return m.now()
	}
	return time.Now()
}
