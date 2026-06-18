# Research: OpenAI Responses API Image Input Format

- **Query**: How does the OpenAI Responses API handle image inputs?
- **Scope**: External (OpenAI documentation and real-world examples)
- **Date**: 2026-06-19

## Findings

### 1. Request Body Format for Images in Responses API

The Responses API (`/v1/responses`) uses a **different structure** from Chat Completions:

```json
{
  "model": "gpt-5.5",
  "input": [
    {
      "role": "user",
      "content": [
        { "type": "input_text", "text": "What's in this image?" },
        {
          "type": "input_image",
          "image_url": "https://example.com/image.jpg",
          "detail": "auto"
        }
      ]
    }
  ]
}
```

**Key differences from Chat Completions**:
- Top-level field is `input` (not `messages`)
- Content type is `input_image` (not `image_url`)
- `image_url` is a direct string (not nested object with `url` property)
- Text content type is `input_text` (not `text`)

### 2. Content Type Options

| Responses API Type | Description |
|---|---|
| `input_text` | Text input from user |
| `input_image` | Image input (URL or base64) |
| `input_file` | File input (PDF, etc.) |
| `output_text` | Assistant output text |

**Note**: `input_image` is the ONLY content type for images in the Responses API. There is no `image_file` type.

### 3. Image URL Support

**Both base64 data URLs and HTTP URLs are supported:**

**HTTP URL**:
```json
{
  "type": "input_image",
  "image_url": "https://upload.wikimedia.org/wikipedia/commons/thumb/d/dd/Gfp-wisconsin-madison-the-nature-boardwalk.jpg/2560px-Gfp-wisconsin-madison-the-nature-boardwalk.jpg"
}
```

**Base64 Data URL**:
```json
{
  "type": "input_image",
  "image_url": "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD..."
}
```

**File ID** (via Files API):
```json
{
  "type": "input_image",
  "file_id": "file-abc123"
}
```

### 4. Detail Parameter

The `detail` parameter controls image resolution:
- `auto` - Let the model decide (default)
- `low` - Lower resolution, faster processing
- `high` - Higher resolution, more detailed analysis
- `original` - Full resolution (gpt-5.5 specific)

```json
{
  "type": "input_image",
  "image_url": "https://example.com/image.jpg",
  "detail": "high"
}
```

### 5. Comparison: Responses API vs Chat Completions

| Aspect | Chat Completions | Responses API |
|---|---|---|
| Input field | `messages[]` | `input[]` |
| Image content type | `image_url` | `input_image` |
| Image URL structure | `{ type: "image_url", image_url: { url: "..." } }` | `{ type: "input_image", image_url: "..." }` |
| Text content type | `text` | `input_text` |
| Detail parameter | Nested in `image_url` object | Direct property on `input_image` |
| File support | Limited (PDF via base64 only) | Native `input_file` type |

### 6. Supported Image Formats

- PNG (`.png`)
- JPEG (`.jpeg`, `.jpg`)
- WebP (`.webp`)
- Non-animated GIF (`.gif`)

### 7. Code Examples

**Python (HTTP URL)**:
```python
response = client.responses.create(
    model="gpt-5.5",
    input=[
        {
            "role": "user",
            "content": [
                {"type": "input_text", "text": "What is in this image?"},
                {
                    "type": "input_image",
                    "image_url": "https://example.com/image.jpg",
                    "detail": "auto"
                }
            ]
        }
    ]
)
```

**Python (Base64)**:
```python
import base64

def encode_image(image_path):
    with open(image_path, "rb") as image_file:
        return base64.b64encode(image_file.read()).decode("utf-8")

base64_image = encode_image("image.jpg")

response = client.responses.create(
    model="gpt-5.5",
    input=[
        {
            "role": "user",
            "content": [
                {"type": "input_text", "text": "What is in this image?"},
                {
                    "type": "input_image",
                    "image_url": f"data:image/jpeg;base64,{base64_image}",
                    "detail": "high"
                }
            ]
        }
    ]
)
```

**JavaScript/TypeScript**:
```typescript
const response = await openai.responses.create({
    model: "gpt-5.5",
    input: [
        {
            role: "user",
            content: [
                { type: "input_text", text: "What's in this image?" },
                {
                    type: "input_image",
                    image_url: `data:image/jpeg;base64,${base64Image}`,
                    detail: "auto"
                }
            ]
        }
    ]
});
```

### 8. External References

- [Images and Vision Guide](https://developers.openai.com/api/docs/guides/images-vision) - Official OpenAI documentation
- [Responses API Reference](https://developers.openai.com/api/reference/resources/responses/) - API schema definitions
- [File Inputs Guide](https://developers.openai.com/api/docs/guides/file-inputs) - File handling in Responses API
- [Migration Guide](https://developers.openai.com/api/docs/guides/migrate-to-responses) - Chat Completions to Responses migration

## Caveats / Not Found

1. **Batch API limitation**: The Batch API may not fully support `input_image` type - some users report needing to use `image_url` type instead when using Batch API
2. **Assistant role restriction**: The `assistant` role in Responses API only supports `output_text` content type, not `input_text`
3. **Recent changes**: Some content type restrictions have been tightened recently (e.g., `input_text` removed from certain contexts)
4. **File ID usage**: While `file_id` is supported for images, the primary methods are URL and base64
