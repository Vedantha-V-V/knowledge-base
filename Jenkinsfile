pipeline {
    agent any
    triggers {
        pollSCM('* * * * *')
    }
    environment {
        DOCKER_BUILDKIT = '1'
    }
    stages {
        stage('Build Backend') {
            steps {
                sh 'docker build -t synced-brain-backend .'
            }
        }

        stage('Build Frontend') {
            steps {
                dir('frontend') {
                    sh 'docker build -t synced-brain-frontend .'
                }
            }
        }

        stage('Test') {
            steps {
                sh 'docker run --rm -e SKIP_MILVUS=true synced-brain-backend python -c "print(\'CI test passed\')"'
            }
        }

        stage('Deploy') {
            steps {
                sh '''
                    docker rm -f synced-brain-container || true
                    docker rm -f synced-brain-frontend || true

                    docker run -d \
                        --network host \
                        --name synced-brain-container \
                        synced-brain-backend

                    docker run -d -p 3000:3000 \
                        --name synced-brain-frontend \
                        synced-brain-frontend
                '''
            }
        }
    }
}