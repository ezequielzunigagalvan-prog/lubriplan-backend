#!/bin/bash

# 1. Login para obtener token
echo "=== LOGIN ==="
LOGIN_RESPONSE=$(curl -s -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@lubriplan.com","password":"password"}')

echo "Login response: $LOGIN_RESPONSE"

TOKEN=$(echo "$LOGIN_RESPONSE" | grep -o '"token":"[^"]*' | cut -d'"' -f4)
echo "Token: $TOKEN"

# 2. Test del endpoint /api/maintenance/me/access CON header x-plant-id
echo -e "\n=== TEST /api/maintenance/me/access WITH PLANT ID ==="
curl -s -X GET http://localhost:3001/api/maintenance/me/access \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-plant-id: 1" | jq .

# 3. Test SIN header x-plant-id
echo -e "\n=== TEST /api/maintenance/me/access WITHOUT PLANT ID ==="
curl -s -X GET http://localhost:3001/api/maintenance/me/access \
  -H "Authorization: Bearer $TOKEN" | jq .
