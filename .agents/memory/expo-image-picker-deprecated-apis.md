---
name: expo-image-picker deprecated APIs
description: ImagePicker.MediaTypeOptions.* is removed in expo-image-picker v15+; use string array literals instead.
---

# expo-image-picker deprecated APIs

## The rule
`ImagePicker.MediaTypeOptions.Images` and `ImagePicker.MediaTypeOptions.Videos` are **removed** in expo-image-picker v15+. Any occurrence in the codebase is a type error.

Use string array literals instead:

```typescript
// OLD (broken):
mediaTypes: ImagePicker.MediaTypeOptions.Images
mediaTypes: ImagePicker.MediaTypeOptions.Videos
mediaTypes: ImagePicker.MediaTypeOptions.All

// NEW (correct):
mediaTypes: ['images']
mediaTypes: ['videos']
mediaTypes: ['images', 'videos']
```

**Why:** expo-image-picker moved from an enum to a `MediaType[]` type. The enum was deprecated in v14 and removed in v15.

## How to apply
Grep for `MediaTypeOptions` in any picker file and replace with string arrays. The TypeScript compiler will catch remaining instances via `pnpm --filter travel-buddy exec tsc --noEmit`.
