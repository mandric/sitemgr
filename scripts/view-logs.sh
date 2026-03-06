#!/bin/bash
# Open Edge Function logs in browser

PROJECT_REF=$(grep SUPABASE_PROJECT_REF .env.production | cut -d= -f2)
URL="https://supabase.com/dashboard/project/${PROJECT_REF}/functions/whatsapp/logs"

echo "Opening logs in browser..."
echo "$URL"

if command -v open &> /dev/null; then
    open "$URL"
elif command -v xdg-open &> /dev/null; then
    xdg-open "$URL"
else
    echo "Please open this URL manually"
fi
