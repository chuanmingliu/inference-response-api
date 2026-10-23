// Local-only official Go SDK smoke test. Run from this directory:
// API_BASE_URL=http://127.0.0.1:8089/v1 go run . -report ../../docs/core-sdk-go-vllm-metal.json
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime/debug"
	"strings"
	"time"

	"github.com/openai/openai-go/v3"
	"github.com/openai/openai-go/v3/option"
	"github.com/openai/openai-go/v3/responses"
)

type checkResult struct {
	Name        string  `json:"name"`
	Passed      bool    `json:"passed"`
	ResponseID  string  `json:"response_id,omitempty"`
	Status      string  `json:"status,omitempty"`
	OutputBytes int     `json:"output_bytes,omitempty"`
	DeltaCount  int     `json:"delta_count,omitempty"`
	Duration    float64 `json:"duration_seconds"`
	Error       string  `json:"error,omitempty"`
}

func environment(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func localURL(value string) (*url.URL, error) {
	u, err := url.Parse(value)
	if err != nil {
		return nil, err
	}
	local := u.Hostname() == "127.0.0.1" || u.Hostname() == "localhost" || u.Hostname() == "::1" || u.Hostname() == "host.docker.internal"
	if (u.Scheme != "http" && u.Scheme != "https") || !local || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, errors.New("API_BASE_URL must be a local HTTP(S) gateway without URL credentials, query, or fragment")
	}
	return u, nil
}

func canonicalText(response responses.Response) string {
	var text strings.Builder
	for _, item := range response.Output {
		if item.Type == "message" {
			for _, part := range item.Content {
				if part.Type == "output_text" {
					text.WriteString(part.Text)
				}
			}
		}
	}
	return text.String()
}

func validateResponse(response responses.Response) error {
	if response.Status != "completed" || !strings.HasPrefix(response.ID, "resp_") {
		return fmt.Errorf("unexpected response identity/status: %s %s (%s)", response.ID, response.Status, response.Error.Message)
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal([]byte(response.RawJSON()), &raw); err != nil {
		return err
	}
	if string(raw["store"]) != "false" || string(raw["error"]) != "null" || string(raw["incomplete_details"]) != "null" {
		return errors.New("completed Response has invalid retention/error/incomplete fields")
	}
	text := canonicalText(response)
	if strings.TrimSpace(text) == "" || text != response.OutputText() {
		return errors.New("SDK OutputText() disagrees with canonical Items or is empty")
	}
	ids := map[string]bool{}
	for _, item := range response.Output {
		if item.ID == "" || ids[item.ID] {
			return errors.New("missing or duplicate output Item ID")
		}
		ids[item.ID] = true
	}
	u := response.Usage
	if !response.JSON.Usage.Valid() || u.InputTokens < 0 || u.OutputTokens < 0 || u.TotalTokens != u.InputTokens+u.OutputTokens {
		return errors.New("missing or inconsistent measured token usage")
	}
	return nil
}

func runCreate(ctx context.Context, client openai.Client, params responses.ResponseNewParams) (checkResult, error) {
	result := checkResult{Name: "json_create"}
	response, err := client.Responses.New(ctx, params)
	if err != nil {
		return result, err
	}
	result.ResponseID, result.Status, result.OutputBytes = response.ID, string(response.Status), len(response.OutputText())
	return result, validateResponse(*response)
}

func runStream(ctx context.Context, client openai.Client, params responses.ResponseNewParams) (checkResult, error) {
	result := checkResult{Name: "sse_stream"}
	stream := client.Responses.NewStreaming(ctx, params)
	defer stream.Close()
	var text strings.Builder
	var final responses.Response
	var deltas []responses.ResponseStreamEventUnion
	sequence, terminals := int64(0), 0
	for stream.Next() {
		event := stream.Current()
		if event.SequenceNumber != sequence || (sequence == 0 && event.Type != "response.created") {
			return result, errors.New("stream event ordering or sequence_number is invalid")
		}
		sequence++
		if terminals != 0 {
			return result, errors.New("event arrived after the terminal response")
		}
		switch event.Type {
		case "response.output_text.delta":
			text.WriteString(event.Delta)
			deltas = append(deltas, event)
		case "response.completed", "response.failed", "response.incomplete":
			terminals++
			final = event.Response
		case "error":
			return result, fmt.Errorf("stream error: %s %s", event.Code, event.Message)
		}
	}
	if err := stream.Err(); err != nil {
		return result, err
	}
	if terminals != 1 {
		return result, errors.New("stream ended without exactly one terminal response")
	}
	if err := validateResponse(final); err != nil {
		return result, err
	}
	if text.String() != final.OutputText() || len(deltas) == 0 {
		return result, errors.New("stream deltas disagree with canonical final output")
	}
	for _, delta := range deltas {
		if delta.OutputIndex < 0 || delta.OutputIndex >= int64(len(final.Output)) {
			return result, errors.New("delta output_index is out of bounds")
		}
		item := final.Output[delta.OutputIndex]
		if delta.ItemID != item.ID || delta.ContentIndex < 0 || delta.ContentIndex >= int64(len(item.Content)) || item.Content[delta.ContentIndex].Type != "output_text" {
			return result, errors.New("delta identity/content_index disagrees with final Items")
		}
	}
	result.ResponseID, result.Status = final.ID, string(final.Status)
	result.OutputBytes, result.DeltaCount = len(text.String()), len(deltas)
	return result, nil
}

func run() error {
	base := flag.String("api-base-url", environment("API_BASE_URL", "http://127.0.0.1:8089/v1"), "local gateway URL")
	model := flag.String("model", os.Getenv("API_MODEL"), "model; defaults to local /api/config")
	reportPath := flag.String("report", "", "optional JSON evidence output path")
	timeout := flag.Duration("timeout", 180*time.Second, "timeout per check")
	outputTokens := flag.Int64("max-output-tokens", 256, "output token budget per request")
	flag.Parse()
	u, err := localURL(*base)
	if err != nil {
		return err
	}
	if *timeout <= 0 || *outputTokens < 1 {
		return errors.New("timeout and max-output-tokens must be positive")
	}
	key := environment("API_KEY", "local")
	httpClient := &http.Client{Timeout: *timeout, CheckRedirect: func(req *http.Request, _ []*http.Request) error {
		_, err := localURL(req.URL.String())
		return err
	}}
	if *model == "" {
		configURL := u.Scheme + "://" + u.Host + "/api/config"
		req, err := http.NewRequest(http.MethodGet, configURL, nil)
		if err != nil {
			return err
		}
		req.Header.Set("Authorization", "Bearer "+key)
		response, err := httpClient.Do(req)
		if err != nil {
			return err
		}
		defer response.Body.Close()
		if response.StatusCode != http.StatusOK {
			return fmt.Errorf("config lookup failed: HTTP %d", response.StatusCode)
		}
		var config struct{ Model string }
		if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&config); err != nil {
			return err
		}
		*model = config.Model
	}
	if *model == "" {
		return errors.New("API_MODEL is empty and config supplied no model")
	}
	client := openai.NewClient(option.WithBaseURL(strings.TrimRight(*base, "/")+"/"), option.WithAPIKey(key), option.WithHTTPClient(httpClient), option.WithMaxRetries(0))
	params := responses.ResponseNewParams{Model: *model, Store: openai.Bool(false), MaxOutputTokens: openai.Int(*outputTokens), Input: responses.ResponseNewParamsInputUnion{OfString: openai.String("Say hello in one short sentence.")}}
	checks := []checkResult{}
	passed := true
	for _, check := range []func(context.Context, openai.Client, responses.ResponseNewParams) (checkResult, error){runCreate, runStream} {
		started := time.Now()
		ctx, cancel := context.WithTimeout(context.Background(), *timeout)
		result, err := check(ctx, client, params)
		cancel()
		result.Duration = time.Since(started).Seconds()
		result.Passed = err == nil
		if err != nil {
			result.Error = err.Error()
			passed = false
		}
		checks = append(checks, result)
	}
	sdk := "github.com/openai/openai-go/v3 (unknown build version)"
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, dependency := range info.Deps {
			if dependency.Path == "github.com/openai/openai-go/v3" {
				sdk = dependency.Path + " " + dependency.Version
			}
		}
	}
	report := map[string]any{"recorded_at": time.Now().UTC().Format(time.RFC3339), "sdk": sdk, "base_url": *base, "model": *model, "checks": checks, "passed": passed, "evidence": "official SDK create/stream with semantic assertions; not full conformance"}
	encoded, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		return err
	}
	if *reportPath != "" {
		if err := os.MkdirAll(filepath.Dir(*reportPath), 0755); err != nil {
			return err
		}
		if err := os.WriteFile(*reportPath, append(encoded, '\n'), 0644); err != nil {
			return err
		}
	}
	fmt.Println(string(encoded))
	if !passed {
		return errors.New("one or more Go SDK checks failed")
	}
	return nil
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
