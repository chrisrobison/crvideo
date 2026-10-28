<?php
declare(strict_types=1);

// ia-import/src/ArchiveListParser.php
//
// Reads an Internet Archive user-created-list export (see README for the
// exact shape) and turns it into a plain, validated structure. Never writes
// back to the source file. Tolerant of individual malformed members -- it
// records a warning and skips that member rather than aborting the whole
// import, per spec ("continue processing when an individual entry fails").

final class ArchiveListParser
{
    /**
     * @return array{
     *   list_name: string,
     *   description: string,
     *   is_private: bool|null,
     *   list_id: mixed,
     *   date_created: string|null,
     *   members: list<array{identifier: string, member_id: mixed, date_added: mixed, original_position: int}>,
     *   warnings: list<string>,
     * }
     */
    public static function parse(string $path): array
    {
        if (!is_file($path) || !is_readable($path)) {
            throw new RuntimeException("List file not found or not readable: $path");
        }

        $raw = file_get_contents($path);
        if ($raw === false) {
            throw new RuntimeException("Failed to read list file: $path");
        }

        $data = json_decode($raw, true);
        if (json_last_error() !== JSON_ERROR_NONE) {
            throw new InvalidArgumentException('Invalid JSON in list file: ' . json_last_error_msg());
        }

        if (!is_array($data)) {
            throw new InvalidArgumentException('List file does not contain a JSON object.');
        }

        if (($data['success'] ?? null) !== true) {
            throw new InvalidArgumentException('List file is missing "success": true at the top level.');
        }

        $value = $data['value'] ?? null;
        if (!is_array($value)) {
            throw new InvalidArgumentException('List file is missing a "value" object.');
        }

        $membersRaw = $value['members'] ?? null;
        if (!is_array($membersRaw)) {
            throw new InvalidArgumentException('List "value.members" must be an array.');
        }

        $warnings = [];
        $members = [];
        $position = 0;
        foreach ($membersRaw as $index => $m) {
            $position++;
            if (!is_array($m)) {
                $warnings[] = "Member at position $position is not an object; skipped.";
                continue;
            }
            $identifier = $m['identifier'] ?? null;
            if (!is_string($identifier) || trim($identifier) === '') {
                $warnings[] = "Member at position $position is missing a valid \"identifier\"; skipped.";
                continue;
            }
            $members[] = [
                'identifier' => trim($identifier),
                'member_id' => $m['member_id'] ?? null,
                'date_added' => $m['date_added'] ?? null,
                'original_position' => $position,
            ];
        }

        if (!$members) {
            $warnings[] = 'No valid members found in list.';
        }

        $isPrivate = $value['is_private'] ?? null;

        return [
            'list_name' => is_string($value['list_name'] ?? null) ? $value['list_name'] : 'Untitled List',
            'description' => is_string($value['description'] ?? null) ? $value['description'] : '',
            'is_private' => is_bool($isPrivate) ? $isPrivate : null,
            'list_id' => $value['id'] ?? null,
            'date_created' => is_string($value['date_created'] ?? null) ? $value['date_created'] : null,
            'members' => $members,
            'warnings' => $warnings,
        ];
    }
}
